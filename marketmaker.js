import { DataFeedConsumer } from './DataFeed.js'

import fs from 'fs'
import prompt from 'prompt'
import sjcl from 'sjcl'
import BN from 'bignumber.js'

import microtick from 'mtapi'

const configFile = "config.json"
const config = JSON.parse(fs.readFileSync(configFile))

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
    console.log(error.stack[0])
  }
})

class MarketMaker extends DataFeedConsumer {
    
    constructor() {
        super("marketmaker")
        this.logging = false
        this.api = new microtick(config.api)
        this.state = {
            funded: false
        }
    }
    
    async init() {
        // Check for account on startup
        if (config.account === undefined) {
          // Generate new account, encrypt private key with prompted password
          await this.api.init("software")
          const account = await this.api.getWallet()
          const password = await this.doPrompt("New account")
          account.priv = Buffer.from(sjcl.encrypt(password, account.priv)).toString('base64')
          config.account = account
          fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
          console.log("Updated your config with new generated account: ")
          console.log(JSON.stringify(config.account, null, 2))
        
          process.exit()
        } else {
          const password = await this.doPrompt("Account")
          try {
            config.account.priv = sjcl.decrypt(password, Buffer.from(config.account.priv, 'base64').toString())
          } catch (err) {
            console.log("Invalid password")
            process.exit()
          }
          await this.api.init(config.account)
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
    
    addMarket(symbol) {
        this.subscribeTicker(symbol)
        this.api.subscribe(symbol)
    }
    
    async chainBlockHandler(block) {
        const info = await this.api.getAccountInfo(config.account.acct)
        this.state.funded = info.balance >= config.minBalance
        this.state.funds = info.balance
        const backing = {}
        const quotes = []
        for (var i=0; i<info.activeQuotes.length; i++) {
            const id = info.activeQuotes[i]
            
            const quote = await this.api.getLiveQuote(id)
            const dur = reverseLookup[quote.duration]
            quote.stale = (Date.now() - quote.modified) / 1000 > dur * config.stalePercent
            quote.frozen = (Date.now() - quote.canModify) < 0
            quotes.push(quote)
            
            let currentBacking = 0
            if (backing[dur] === undefined) {
                backing[dur] = quote.backing
            } else {
                currentBacking = backing[dur]
                backing[dur] += quote.backing
                if (backing[dur] > config.backing[dur]) {
                    // Cancel quote
                    console.log("Canceling quote (backing)")
                    backing[dur] -= quote.backing
                    this.api.cancelQuote(quote.id)
                }
            }
            
            if (!quote.frozen) {
                
                if (this.state.consensus !== undefined && this.state.targetSpot !== undefined && this.state.targetPremiums !== undefined) {
                        
                    const midSpot = (this.state.targetSpot + this.state.consensus) / 2
                    const dynamicRatio = 1 + currentBacking / config.backing[dur]
                    const markupPremium = this.state.targetPremiums[dur] * config.staticMarkup * dynamicRatio * config.dynamicMarkup
                    const deltaAdjustment = Math.abs(this.state.targetSpot - this.state.consensus) / 2
                    const quotePremium = markupPremium + deltaAdjustment
                    
                    // Update if stale
                    if (quote.stale) {
                        const newSpot = new BN(midSpot).toFixed(6) + "spot"
                        const newPremium = new BN(quotePremium).toFixed(6) + "premium"
                        console.log("Updating quote (stale): " + quote.id + " " + quote.market + " " + quote.duration + " " + quote.backing + "dai " + newSpot + " " + 
                            "[" + new BN(this.state.targetPremiums[dur]).toFixed(6) + " * " + config.staticMarkup + " * " + new BN(dynamicRatio).toFixed(2) + " * " + 
                            config.dynamicMarkup + " + " + new BN(deltaAdjustment).toFixed(6) + " = " + newPremium + "]")
                        this.api.updateQuote(quote.id, newSpot, newPremium)
                    }
                    
                    // Update if premium in either direction drops below target
                    const thresholdPremium = this.state.targetPremiums[dur] * config.premiumThreshold
                    if (Math.min(quote.premiumAsCall, quote.premiumAsPut) < thresholdPremium) {
                        const newSpot = new BN(midSpot).toFixed(6) + "spot"
                        const newPremium = new BN(quotePremium).toFixed(6) + "premium"
                        console.log("Updating quote (premium): " + quote.id + " " + quote.market + " " + quote.duration + " " + quote.backing + "dai " + newSpot + " " + 
                            "[" + new BN(this.state.targetPremiums[dur]).toFixed(6) + " * " + config.staticMarkup + " * " + new BN(dynamicRatio).toFixed(2) + " * " + 
                            config.dynamicMarkup + " + " + new BN(deltaAdjustment).toFixed(6) + " = " + newPremium + "]")
                        this.api.updateQuote(quote.id, newSpot, newPremium)
                    }
                }
            }
        }
        
        this.state.quotes = quotes
        this.state.backing = backing
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
            if (this.state.consensus !== undefined) {
                const midSpot = (spot + this.state.consensus) / 2
                Object.keys(this.state.targetPremiums).map(dur => {
                    let currentBacking = 0
                    if (this.state.backing !== undefined && this.state.backing[dur] !== undefined) {
                        currentBacking = this.state.backing[dur]
                    }
                    if (config.backing[dur] > currentBacking) {
                        const dynamicRatio = 1 + currentBacking / config.backing[dur]
                        const markupPremium = this.state.targetPremiums[dur] * config.staticMarkup * dynamicRatio * config.dynamicMarkup
                        const deltaAdjustment = Math.abs(spot - this.state.consensus) / 2
                        const quotePremium = markupPremium + deltaAdjustment
                        
                        const tmpDuration = lookup[dur]
                        const tmpBacking = new BN(config.backing[dur]).minus(currentBacking).toFixed(6) + "dai"
                        const tmpSpot = new BN(midSpot).toFixed(6) + "spot"
                        const tmpPremium = new BN(quotePremium).toFixed(6) + "premium"
                        
                        console.log("Creating quote: " + symbol + " " + tmpDuration + " " + tmpBacking + " " + tmpSpot + " " + 
                            "[" + new BN(this.state.targetPremiums[dur]).toFixed(6) + " * " + config.staticMarkup + " * " + new BN(dynamicRatio).toFixed(2) + " * " + 
                            config.dynamicMarkup + " + " + new BN(deltaAdjustment).toFixed(6) + " = " + tmpPremium + "]")
                        this.api.createQuote(symbol, tmpDuration, tmpBacking, tmpSpot, tmpPremium)
                    }
                })  
            }
        } else {
            if (this.state.funds !== undefined) {
                console.log("Out of funds: " + config.account.acct + ": " + this.state.funds)
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
