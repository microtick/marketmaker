import axios from 'axios'
import { DataFeedProducer } from './DataFeed.js'

const coincap = "https://api.coincap.io/v2"
const symbols = {
    XBTUSD: "bitcoin",
    ETHUSD: "ethereum"
}
const ratios = {
    XBTETH: [ "XBTUSD", "ETHUSD"]
}
const sampleTime = 10

class CoinCapFeed extends DataFeedProducer {
    
    constructor() {
        super("coincap-feed", sampleTime) 
    }
    
    async init() {
        const keys = Object.keys(symbols)
        this.query = coincap + "/assets?ids=" + keys.reduce((acc, key, i) => {
            if (i > 0) {
                acc += ","
            }
            acc += symbols[key]
            return acc
        }, "")
        
        this.reverseLookup = {}
        let end = Date.now()
        let start = end - 3600000 // 1 hour
        const cache = {}
        await Promise.all(keys.map(async key => {
            this.reverseLookup[symbols[key]] = key
            // Query history
            const histQuery = coincap + "/assets/" + symbols[key] + "/history?interval=m1&start=" + start + "&end=" + end
            const hist = await axios.get(histQuery)
            cache[key] = []
            hist.data.data.map(data => {
                for (var i=0; i<60; i+=sampleTime) {
                    cache[key].push(this.update(key, data.priceUsd))
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
            res.data.data.map(d => {
                const key = this.reverseLookup[d.id]
                cache[key] = this.update(key, d.priceUsd)
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

const feed = new CoinCapFeed()
feed.init()
