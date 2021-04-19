import { DataFeedConsumer } from './DataFeed.js'

import fs from 'fs'
import prompt from 'prompt'
import sjcl from 'sjcl'
import BN from 'bignumber.js'

import winston from 'winston'

const { combine, timestamp, printf } = winston.format

const logFormat = printf(({ level, message, timestamp }) => {
    level = level.toUpperCase()
    return `${timestamp} ${level} ${message}`
});

const logger = winston.createLogger({
  level: 'info',
  format: combine(
    timestamp(),
    logFormat
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
})

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: combine(
        timestamp(),
        logFormat
    )
  }))
}

import microtick from 'mtapi'

const configFile = "config.json"
let config = JSON.parse(fs.readFileSync(configFile))
fs.watchFile(configFile, () => {
    logger.info("Reloading config file")
    config = JSON.parse(fs.readFileSync(configFile))
})

const walletFile = "wallet.json"
const wallet = JSON.parse(fs.readFileSync(walletFile))

const api = "localhost:1320"

process.on('unhandledRejection', error => {
  if (error !== undefined) {
    console.log('unhandled promise rejection: ', error.message)
    console.log(error.stack)
  }
})

class MarketMaker extends DataFeedConsumer {
    
    constructor() {
        super("marketmaker")
        logger.info("Starting market maker")
        this.logging = false
        this.api = new microtick(config.api)
        this.state = {
            funded: false,
            markets: {}
        }
        this.processing = false
    }
    
    async init() {
        // Check for account on startup
        if (wallet.account === undefined) {
          // Generate new account, encrypt private key with prompted password
          await this.api.init("software")
          const account = await this.api.getWallet()
          const password = await this.doPrompt("New account")
          account.priv = Buffer.from(sjcl.encrypt(password, account.priv)).toString('base64')
          wallet.account = account
          fs.writeFileSync(walletFile, JSON.stringify(wallet, null, 2))
          console.log("Updated your wallet with new generated account: ")
          console.log(JSON.stringify(wallet.account, null, 2))
        
          process.exit()
        } else {
          const password = await this.doPrompt("Account")
          try {
            wallet.account.priv = sjcl.decrypt(password, Buffer.from(wallet.account.priv, 'base64').toString())
          } catch (err) {
            console.log("Invalid password")
            process.exit()
          }
          await this.api.init(wallet.account)
        }
        
        this.lookup = {}
        Object.keys(config.chain.durations).map(k => {
            const s = config.chain.durations[k]
            this.lookup[s] = k
        })
        
        this.api.addBlockHandler(this.chainBlockHandler.bind(this))
        this.api.addTickHandler(this.chainTickHandler.bind(this))
        
        const info = await this.api.getAccountInfo(wallet.account.acct)
        this.state.funded = info.balance >= config.minBalance
        this.state.funds = info.balance
        if (!this.state.funded) {
            logger.error("Out of funds: " + wallet.account.acct + ": " + this.state.funds)
        }
    }
    
    async doPrompt(message) {
        const password = await new Promise( (resolve, reject) => {
            prompt.start()
            prompt.message = message
            prompt.delimiter = ' '
           
            var schema = {
                properties: {
                    password: {
                        hidden: true
                    }
                }
            }
          
            prompt.get(schema, async (err, res) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(res.password)
                }
            })
        })
        return password
    }
    
    async addMarket(symbol) {
        this.subscribeTicker(symbol)
        this.api.subscribe(symbol)
        const marketInfo = await this.api.getMarketSpot(symbol)
        this.state.markets[symbol] = {
            consensus: marketInfo.consensus
        }
    }
    
    async chainBlockHandler(block) {
        if (this.processing) return
        this.processing = true
        
        const info = await this.api.getAccountInfo(wallet.account.acct)
        this.state.funded = info.balance >= config.minBalance
        this.state.funds = info.balance
        
        const tradeBacking = {}
        for (i=0; i<info.activeTrades.length; i++) {
            const id = info.activeTrades[i]
            const trade = await this.api.getLiveTrade(id)
            const dur = config.chain.durations[trade.duration]
            if (tradeBacking[trade.market] === undefined) {
                tradeBacking[trade.market] = {}   
            }
            if (tradeBacking[trade.market][dur] === undefined) {
                tradeBacking[trade.market][dur] = trade.backing
            } else {
                tradeBacking[trade.market][dur] = new BN(tradeBacking[trade.market][dur]).plus(trade.backing).toNumber()
            }
            
            // Settle trade if expiration is past
            if (Date.now() - trade.expiration > config.chain.blocktime) {
                logger.info("Settling trade " + id)
                this.api.settleTrade(trade.id)
            }
        }
        
        const quoteBacking = {}
        for (var i=0; i<info.activeQuotes.length; i++) {
            const id = info.activeQuotes[i]
            
            const quote = await this.api.getLiveQuote(id)
            const market = quote.market
            const dur = config.chain.durations[quote.duration]
            quote.stale = (Date.now() - quote.modified) / 1000 > dur * config.staleFraction
            quote.frozen = (Date.now() - quote.canModify) < config.chain.blocktime
            
            let currentBacking = 0
            let pending = false
            if (quoteBacking[market] === undefined) {
                quoteBacking[market] = {}
            }
            if (quoteBacking[market][dur] === undefined) {
                quoteBacking[market][dur] = quote.backing
            } else {
                currentBacking = quoteBacking[market][dur]
                quoteBacking[market][dur] = new BN(quoteBacking[market][dur]).plus(quote.backing).toNumber()
            }
            
            if (!quote.frozen) {
                
                if (quote.backing < config.minBacking || quote.backing > config.maxBacking || quoteBacking[market][dur] > config.targetBacking[dur]) {
                    // Cancel quote
                    if (!pending) {
                        quoteBacking[market][dur] = new BN(quoteBacking[market][dur]).minus(quote.backing).toNumber()
                        logger.info("Canceling quote " + id + " (backing): " + quote.market + " " + quote.duration + " " + quote.backing + "dai")
                        this.api.cancelQuote(quote.id)
                        pending = true
                    }
                }
            
                if (this.state.markets[market].targetSpot !== undefined && this.state.markets[market].targetPremiums !== undefined) {
                        
                    let spotAdjustment = this.state.markets[market].targetSpot
                    let deltaAdjustment = 0
                    if (this.state.markets[market].consensus !== undefined && this.state.markets[market].consensus > 0) {
                        //spotAdjustment = config.externalSpotWeight * this.state.markets[market].targetSpot + (1 - config.externalSpotWeight) * this.state.markets[market].consensus
                        deltaAdjustment = Math.abs(spotAdjustment - this.state.markets[market].consensus) / 2
                    }
                    
                    let thisTradeBacking = 0
                    if (tradeBacking[market] !== undefined && tradeBacking[market][dur] !== undefined) {
                        thisTradeBacking = tradeBacking[market][dur]
                    }
                    
                    const tradeRatio = 1 + thisTradeBacking / config.targetBacking[dur]
                    const dynamicRatio = 1 + currentBacking / config.targetBacking[dur]
                    const markupPremium = this.state.markets[market].targetPremiums[dur] * tradeRatio * config.staticMarkup * dynamicRatio * config.dynamicMarkup
                    const quotePremium = markupPremium + deltaAdjustment
                    
                    // Update if stale
                    if (quote.stale) {
                        const newSpot = new BN(spotAdjustment).toFixed(6) + "spot"
                        const newPremium = new BN(quotePremium).toFixed(6) + "premium"
                        if (!pending) {
                            logger.info("Updating quote (stale): " + quote.id + " " + quote.market + " " + quote.duration + " " + quote.backing + "dai " + newSpot + " " + 
                                "[" + new BN(this.state.markets[market].targetPremiums[dur]).toFixed(6) + " * " + new BN(tradeRatio).toFixed(2) + " * " + config.staticMarkup + " * " + 
                                new BN(dynamicRatio).toFixed(2) + " * " +  config.dynamicMarkup + " + " + new BN(deltaAdjustment).toFixed(6) + " = " + newPremium + "]")
                            this.api.updateQuote(quote.id, newSpot, newPremium)
                            pending = true
                        }
                    }
                    
                    // Update if premium in either direction drops below target
                    const thresholdPremium = this.state.markets[market].targetPremiums[dur] * config.premiumThreshold
                    if (Math.min(quote.premiumAsCall, quote.premiumAsPut) < thresholdPremium) {
                        const newSpot = new BN(spotAdjustment).toFixed(6) + "spot"
                        const newPremium = new BN(quotePremium).toFixed(6) + "premium"
                        if (!pending) {
                            logger.info("Updating quote (premium): " + quote.id + " " + quote.market + " " + quote.duration + " " + quote.backing + "dai " + newSpot + " " + 
                                "[" + new BN(this.state.markets[market].targetPremiums[dur]).toFixed(6) + " * " + new BN(tradeRatio).toFixed(2) + " * " + config.staticMarkup + " * " + 
                                new BN(dynamicRatio).toFixed(2) + " * " +  config.dynamicMarkup + " + " + new BN(deltaAdjustment).toFixed(6) + " = " + newPremium + "]")
                            this.api.updateQuote(quote.id, newSpot, newPremium)
                            pending = true
                        }
                    }
                }
            }
        }
        
        this.state.quoteBacking = quoteBacking
        this.state.tradeBacking = tradeBacking
        //console.log(JSON.stringify(this.state, null, 2))
        
        this.processing = false
    }
    
    chainTickHandler(symbol, payload) {
        //console.log(symbol + ": " + JSON.stringify(payload))
        this.state.markets[symbol].consensus = payload.consensus
    }
    
    microtickCallback(symbol, spot, premiums) {
        if (this.processing) return
        this.processing = true
        
        //console.log(symbol + ": " + spot + " " + JSON.stringify(premiums))
        this.state.markets[symbol].targetSpot = spot
        this.state.markets[symbol].targetPremiums = premiums
        if (this.state.funded) {
            let spotAdjustment = spot
            let deltaAdjustment = 0
            if (this.state.markets[symbol].consensus !== undefined && this.state.markets[symbol].consensus > 0) {
                //spotAdjustment = config.externalSpotWeight * spot + (1 - config.externalSpotWeight) * this.state.markets[symbol].consensus
                deltaAdjustment = Math.abs(spotAdjustment - this.state.markets[symbol].consensus) / 2
            }
            Object.keys(this.state.markets[symbol].targetPremiums).map(dur => {
                let currentBacking = 0
                if (this.state.quoteBacking !== undefined && this.state.quoteBacking[symbol] !== undefined && this.state.quoteBacking[symbol][dur] !== undefined) {
                    currentBacking = this.state.quoteBacking[symbol][dur]
                }
                let thisTradeBacking = 0
                if (this.state.tradeBacking !== undefined && this.state.tradeBacking[symbol] !== undefined && this.state.tradeBacking[symbol][dur] !== undefined) {
                    thisTradeBacking = this.state.tradeBacking[symbol][dur]
                }
                if (config.targetBacking[dur] > currentBacking) {
                    const tradeRatio = 1 + thisTradeBacking / config.targetBacking[dur]
                    const dynamicRatio = 1 + currentBacking / config.targetBacking[dur]
                    const markupPremium = this.state.markets[symbol].targetPremiums[dur] * tradeRatio * config.staticMarkup * dynamicRatio * config.dynamicMarkup
                    const quotePremium = markupPremium + deltaAdjustment
                    
                    let targetBacking = config.targetBacking[dur] - currentBacking
                    if (targetBacking > config.maxBacking) {
                        targetBacking = config.maxBacking
                    }
                    
                    // Only create the quote if it's larger than minBacking
                    const tmpDuration = this.lookup[dur]
                    if (targetBacking >= config.minBacking) {
                        const tmpBacking = new BN(targetBacking).toFixed(6) + "dai"
                        const tmpSpot = new BN(spotAdjustment).toFixed(6) + "spot"
                        const tmpPremium = new BN(quotePremium).toFixed(6) + "premium"
                    
                        logger.info("Creating quote: " + symbol + " " + tmpDuration + " " + tmpBacking + " " + tmpSpot + " " + 
                            "[" + new BN(this.state.markets[symbol].targetPremiums[dur]).toFixed(6) + " * " + new BN(tradeRatio).toFixed(2) + " * " + config.staticMarkup + " * " + 
                            new BN(dynamicRatio).toFixed(2) + " * " +  config.dynamicMarkup + " + " + new BN(deltaAdjustment).toFixed(6) + " = " + tmpPremium + "]")
                        this.api.createQuote(symbol, tmpDuration, tmpBacking, tmpSpot, tmpPremium)
                    } else {
                        logger.warn("Skipping quote creation (min backing): " + symbol + " " + tmpDuration + " " + new BN(targetBacking).toFixed(6) + "dai < " + config.minBacking + "dai") 
                    }
                }
            })
        } else {
            if (this.state.funds !== undefined) {
                logger.error("Out of funds: " + wallet.account.acct + ": " + this.state.funds)
            }
        }
        
        this.processing = false
    }
    
}

async function main() {
    const marketmaker = new MarketMaker()
    await marketmaker.init()
    Object.keys(config.chain.markets.map(key => {
        marketmaker.addMarket(key)
    }))
}

main()
