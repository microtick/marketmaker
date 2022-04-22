import axios from 'axios'
import { DataFeedProducer } from './DataFeed.js'

const kraken = "https://api.kraken.com/0/public"
const symbols = {
    XBTUSD: "XXBTZUSD"
}
const ratios = {
    //XBTETH: [ "XBTUSD", "ETHUSD"]
}
const sampleTime = 10

class KrakenFeed extends DataFeedProducer {
    
    constructor() {
        super("kraken-feed", sampleTime) 
    }
    
    async init() {
        const keys = Object.keys(symbols)
        this.query = kraken + "/Ticker?pair=" + keys.reduce((acc, key, i) => { if (i > 0) {
                acc += ","
            }
            acc += symbols[key]
            return acc
        }, "")
        
        this.reverseLookup = {}
        let now = Math.floor(Date.now() / 1000)
        now = now - (now % 60) - 3600
        const cache = {}
        await Promise.all(keys.map(async key => {
            this.reverseLookup[symbols[key]] = key
            // Query history
            const histQuery = kraken + "/OHLC?since=" + now + "&pair=" + symbols[key]
            const hist = await axios.get(histQuery)
            cache[key] = []
            hist.data.result[symbols[key]].map(data => {
                for (var i=0; i<60; i+=sampleTime) {
                    cache[key].push(this.update(key, data[4]))
                }
            })
        }))
        
        // compute ratios
        Object.keys(ratios).map(key => {
            const r = ratios[key]
            const num = cache[r[0]]
            const den = cache[r[1]]
            if (num.length === den.length) {
                for (var i=0; i<num.length; i++) {
                    this.update(key, num[i] / den[i])
                }
            }
        })
        
        setInterval(this.sample.bind(this), sampleTime * 1000)
        this.sample()
        
        this.syncing = false
    }
    
    async sample() {
        try {
            const res = await axios.get(this.query)
            const cache = {}
            Object.keys(res.data.result).map(key => {
                const k = this.reverseLookup[key]
                cache[k] = this.update(k, res.data.result[key].c[0])
            })
            Object.keys(ratios).map(key => {
                const r = ratios[key]
                this.update(key, cache[r[0]] / cache[r[1]])
            })
        } catch (err) {
            console.error("Error: " + err)
        }
    }
    
}

const feed = new KrakenFeed()
feed.init()
