import { DataFeedConsumer } from './DataFeed.js'

import fs from 'fs'
import prompt from 'prompt'
import sjcl from 'sjcl'
import BN from 'bignumber.js'

import winston from 'winston'

const { combine, label, timestamp, printf } = winston.format

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

const lookup = {
    300: "5minute",
    900: "15minute",
    3600: "1hour",
    14400: "4hour",
    43200: "12hour"
}

const reverseLookup = {
    "5minute": 300,
    "15minute": 900,
    "1hour": 3600,
    "4hour": 14400,
    "12hour": 43200
    
}

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
            funded: false
        }
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
        
        this.api.addBlockHandler(this.chainBlockHandler.bind(this))
        this.api.addTickHandler(this.chainTickHandler.bind(this))
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
        this.state.consensus = marketInfo.consensus
    }
    
    async chainBlockHandler(block) {
        const info = await this.api.getAccountInfo(wallet.account.acct)
        this.state.funded = info.balance >= config.minBalance
        this.state.funds = info.balance
        
        const tradeBacking = {}
        for (i=0; i<info.activeTrades.length; i++) {
            const id = info.activeTrades[i]
            const trade = await this.api.getLiveTrade(id)
            const dur = reverseLookup[trade.duration]
            if (tradeBacking[dur] === undefined) {
                tradeBacking[dur] = trade.backing
            } else {
                tradeBacking[dur] = new BN(tradeBacking[dur]).plus(trade.backing).toNumber()
            }
            
            // Settle trade if expiration is past
            if (Date.now() - trade.expiration > 0) {
                logger.info("Settling trade " + id)
                this.api.settleTrade(trade.id)
            }
        }
        
        const quoteBacking = {}
        const quotes = []
        for (var i=0; i<info.activeQuotes.length; i++) {
            const id = info.activeQuotes[i]
            
            const quote = await this.api.getLiveQuote(id)
            const dur = reverseLookup[quote.duration]
            quote.stale = (Date.now() - quote.modified) / 1000 > dur * config.stalePercent
            quote.frozen = (Date.now() - quote.canModify) < 0
            quotes.push(quote)
            
            let currentBacking = 0
            let pending = false
            if (quoteBacking[dur] === undefined) {
                quoteBacking[dur] = quote.backing
            } else {
                currentBacking = quoteBacking[dur]
                quoteBacking[dur] = new BN(quoteBacking[dur]).plus(quote.backing).toNumber()
                if (quote.backing < config.minBacking || quote.backing > config.maxBacking || quoteBacking[dur] > config.backing[dur]) {
                    // Cancel quote
                    logger.info("Canceling quote " + id + " (backing): " + quote.market + " " + quote.duration + " " + quote.backing + "dai")
                    quoteBacking[dur] -= quote.backing
                    if (!pending) {
                        this.api.cancelQuote(quote.id)
                        pending = true
                    }
                }
            }
            
            if (!quote.frozen) {
                
                if (this.state.targetSpot !== undefined && this.state.targetPremiums !== undefined) {
                        
                    let spotAdjustment = this.state.targetSpot
                    let deltaAdjustment = 0
                    if (this.state.consensus !== undefined) {
                        spotAdjustment = config.externalSpotWeight * this.state.targetSpot + (1 - config.externalSpotWeight) * this.state.consensus
                        deltaAdjustment = Math.abs(spotAdjustment - this.state.consensus) / 2
                    }
                    
                    let thisTradeBacking = 0
                    if (tradeBacking[dur] !== undefined) {
                        thisTradeBacking = tradeBacking[dur]
                    }
                    
                    const tradeRatio = 1 + thisTradeBacking / config.backing[dur]
                    const dynamicRatio = 1 + currentBacking / config.backing[dur]
                    const markupPremium = this.state.targetPremiums[dur] * tradeRatio * config.staticMarkup * dynamicRatio * config.dynamicMarkup
                    const quotePremium = markupPremium + deltaAdjustment
                    
                    // Update if stale
                    if (quote.stale) {
                        const newSpot = new BN(spotAdjustment).toFixed(6) + "spot"
                        const newPremium = new BN(quotePremium).toFixed(6) + "premium"
                        logger.info("Updating quote (stale): " + quote.id + " " + quote.market + " " + quote.duration + " " + quote.backing + "dai " + newSpot + " " + 
                            "[" + new BN(this.state.targetPremiums[dur]).toFixed(6) + " * " + new BN(tradeRatio).toFixed(2) + " * " + config.staticMarkup + " * " + 
                            new BN(dynamicRatio).toFixed(2) + " * " +  config.dynamicMarkup + " + " + new BN(deltaAdjustment).toFixed(6) + " = " + newPremium + "]")
                        if (!pending) {
                            this.api.updateQuote(quote.id, newSpot, newPremium)
                            pending = true
                        }
                    }
                    
                    // Update if premium in either direction drops below target
                    const thresholdPremium = this.state.targetPremiums[dur] * config.premiumThreshold
                    if (Math.min(quote.premiumAsCall, quote.premiumAsPut) < thresholdPremium) {
                        const newSpot = new BN(spotAdjustment).toFixed(6) + "spot"
                        const newPremium = new BN(quotePremium).toFixed(6) + "premium"
                        logger.info("Updating quote (premium): " + quote.id + " " + quote.market + " " + quote.duration + " " + quote.backing + "dai " + newSpot + " " + 
                            "[" + new BN(this.state.targetPremiums[dur]).toFixed(6) + " * " + new BN(tradeRatio).toFixed(2) + " * " + config.staticMarkup + " * " + 
                            new BN(dynamicRatio).toFixed(2) + " * " +  config.dynamicMarkup + " + " + new BN(deltaAdjustment).toFixed(6) + " = " + newPremium + "]")
                        if (!pending) {
                            this.api.updateQuote(quote.id, newSpot, newPremium)
                            pending = true
                        }
                    }
                }
            }
        }
        
        this.state.quotes = quotes
        this.state.quoteBacking = quoteBacking
        this.state.tradeBacking = tradeBacking
        //console.log(JSON.stringify(this.state, null, 2))
    }
    
    chainTickHandler(symbol, payload) {
        //console.log(symbol + ": " + JSON.stringify(payload))
        this.state.consensus = payload.consensus
    }
    
    microtickCallback(symbol, spot, premiums) {
        //console.log(symbol + ": " + spot + " " + JSON.stringify(premiums))
        this.state.targetSpot = spot
        this.state.targetPremiums = premiums
        if (this.state.funded) {
            let spotAdjustment = spot
            let deltaAdjustment = 0
            if (this.state.consensus !== undefined) {
                spotAdjustment = config.externalSpotWeight * spot + (1 - config.externalSpotWeight) * this.state.consensus
                deltaAdjustment = Math.abs(spotAdjustment - this.state.consensus) / 2
            }
            Object.keys(this.state.targetPremiums).map(dur => {
                let currentBacking = 0
                if (this.state.quoteBacking !== undefined && this.state.quoteBacking[dur] !== undefined) {
                    currentBacking = this.state.quoteBacking[dur]
                }
                let thisTradeBacking = 0
                if (this.state.tradeBacking !== undefined && this.state.tradeBacking[dur] !== undefined) {
                    thisTradeBacking = this.state.tradeBacking[dur]
                }
                if (config.backing[dur] > currentBacking) {
                    const tradeRatio = 1 + thisTradeBacking / config.backing[dur]
                    const dynamicRatio = 1 + currentBacking / config.backing[dur]
                    const markupPremium = this.state.targetPremiums[dur] * tradeRatio * config.staticMarkup * dynamicRatio * config.dynamicMarkup
                    const quotePremium = markupPremium + deltaAdjustment
                    
                    let targetBacking = config.backing[dur] - currentBacking
                    if (targetBacking > config.maxBacking) {
                        targetBacking = config.maxBacking
                    }
                    
                    // Only create the quote if it's larger than minBacking
                    const tmpDuration = lookup[dur]
                    if (targetBacking >= config.minBacking) {
                        const tmpBacking = new BN(targetBacking).toFixed(6) + "dai"
                        const tmpSpot = new BN(spotAdjustment).toFixed(6) + "spot"
                        const tmpPremium = new BN(quotePremium).toFixed(6) + "premium"
                    
                        logger.info("Creating quote: " + symbol + " " + tmpDuration + " " + tmpBacking + " " + tmpSpot + " " + 
                            "[" + new BN(this.state.targetPremiums[dur]).toFixed(6) + " * " + new BN(tradeRatio).toFixed(2) + " * " + config.staticMarkup + " * " + 
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
    }
    
}

async function main() {
    const marketmaker = new MarketMaker()
    await marketmaker.init()
    marketmaker.addMarket("ETHUSD")
}

main()
