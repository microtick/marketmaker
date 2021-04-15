import axios from 'axios'
import { DataFeedProducer } from './DataFeed.js'

const coincap = "https://api.coincap.io/v2"
const symbols = {
    XBTUSD: "bitcoin",
    ETHUSD: "ethereum"
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
        await Promise.all(keys.map(async key => {
            this.reverseLookup[symbols[key]] = key
            // Query history
            const histQuery = coincap + "/assets/" + symbols[key] + "/history?interval=m1&start=" + start + "&end=" + end
            const hist = await axios.get(histQuery)
            hist.data.data.map(data => {
                for (var i=0; i<60; i+=sampleTime) {
                    this.update(key, data.priceUsd)
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
            res.data.data.map(d => {
                this.update(this.reverseLookup[d.id], d.priceUsd)
            })
        } catch (err) {
            console.error("Error: " + err)
        }
    }
    
}

const feed = new CoinCapFeed()
feed.init()
