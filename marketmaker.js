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
    "300": "5minute",
    "900": "15minute",
    "3600": "1hour",
    "14400": "4hour",
    "43200": "12hour"
}

const reverseLookup = {
    "5minute": "300",
    "15minute": "900",
    "1hour": "3600",
    "4hour": "14400",
    "12hour": "43200"
    
}

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
        this.state.backing = {}
        this.state.quotes = await Promise.all(info.activeQuotes.map(async id => {
            const quote = await this.api.getLiveQuote(id)
            const dur = reverseLookup[quote.duration]
            if (this.state.backing[dur] === undefined) {
                this.state.backing[dur] = quote.backing
            } else {
                this.state.backing[dur] += quote.backing
            }
            return quote
        }))
        console.log(JSON.stringify(this.state, null, 2))
    }
    
    chainTickHandler(symbol, payload) {
        console.log(symbol + ": " + JSON.stringify(payload))
        this.state.consensus = payload.consensus
    }
    
    microtickCallback(symbol, spot, premiums) {
        console.log(symbol + ": " + spot + " " + JSON.stringify(premiums))
        if (this.state.funded) {
            if (this.state.consensus !== undefined) {
                const midSpot = (spot + this.state.consensus) / 2
                Object.keys(premiums).map(dur => {
                    let currentBacking = 0
                    if (this.state.backing !== undefined) {
                        currentBacking = this.state.backing[dur]
                    }
                    if (config.backing[dur] > currentBacking) {
                        console.log("Goal premium: " + premiums[dur])
                        const markupPremium = premiums[dur] * config.premiumMarkup
                        console.log("Markup premium: " + markupPremium)
                        const quotePremium = markupPremium + Math.abs(spot - this.state.consensus) / 2
                        
                        console.log("Placing quote: " + midSpot + " " + quotePremium)
                        const tmpDuration = lookup[dur]
                        const tmpBacking = new BN(config.backing[dur]).minus(currentBacking).toFixed(6) + "dai"
                        const tmpSpot = new BN(midSpot).toFixed(6) + "spot"
                        const tmpPremium = new BN(quotePremium).toFixed(6) + "premium"
                        this.api.createQuote(symbol, tmpDuration, tmpBacking, tmpSpot, tmpPremium)
                    }
                })  
            }
        } else {
            console.log("Out of funds: " + config.account.acct)
        }
    }
    
}

async function main() {
    const marketmaker = new MarketMaker()
    await marketmaker.init()
    marketmaker.addMarket("ETHUSD")
}

main()
