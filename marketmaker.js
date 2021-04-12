import { DataFeedConsumer } from './DataFeed.js'

import fs from 'fs'
import prompt from 'prompt'
import sjcl from 'sjcl'

import microtick from 'mtapi'

const configFile = "config.json"
const config = JSON.parse(fs.readFileSync(configFile))

const api = "http://localhost:1320"

class MarketMaker extends DataFeedConsumer {
    
    constructor() {
        super("marketmaker")
        this.api = new microtick(config.api)
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
    }
    
    microtickCallback(symbol, spot, premiums) {
        console.log(symbol + ": " + spot + " " + JSON.stringify(premiums))
    }
    
}

async function main() {
    const marketmaker = new MarketMaker()
    await marketmaker.init()
    marketmaker.addMarket("ETHUSD")
}

main()
