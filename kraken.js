import axios from 'axios'
import { DataFeedProducer } from './DataFeed.js'

const kraken = "https://api.kraken.com/0/public"
const symbols = {
    XBTUSD: "XXBTZUSD",
    ETHUSD: "XETHZUSD"
}
const sampleTime = 10

class KrakenFeed extends DataFeedProducer {
    
    constructor() {
        super("kraken-feed", sampleTime) 
    }
    
    async init() {
        const keys = Object.keys(symbols)
        this.query = kraken + "/Ticker?pair=" + keys.reduce((acc, key, i) => {
            if (i > 0) {
                acc += ","
            }
            acc += symbols[key]
            return acc
        }, "")
        
        this.reverseLookup = {}
        let now = Math.floor(Date.now() / 1000)
        now = now - (now % 60) - 3600
        await Promise.all(keys.map(async key => {
            this.reverseLookup[symbols[key]] = key
            // Query history
            const histQuery = kraken + "/OHLC?since=" + now + "&pair=" + symbols[key]
            const hist = await axios.get(histQuery)
            hist.data.result[symbols[key]].map(data => {
                for (var i=0; i<60; i+=sampleTime) {
                    this.update(key, data[4])
                }
            })
        }))
        
        setInterval(this.sample.bind(this), sampleTime * 1000)
        this.sample()
        
        this.syncing = false
    }
    
    async sample() {
        try {
            const res = await axios.get(this.query)
            Object.keys(res.data.result).map(key => {
                this.update(this.reverseLookup[key], res.data.result[key].c[0])
            })
        } catch (err) {
            console.error("Error: " + err)
        }
    }
    
}

const feed = new KrakenFeed()
feed.init()
