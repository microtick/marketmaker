import redis from 'redis'
import SystemNode from './Discovery.js'

const DATA_PRODUCER = "DataFeedProducer"
const DATA_CONSUMER = "DataFeedConsumer"

const TARGETVOLWINDOW = 900

export class DataFeedProducer extends SystemNode {

    constructor(name, sampleTime) {
        super(name, DATA_PRODUCER, intro => {
            if (intro.type === DATA_CONSUMER) {
                this.reannounce()
            }
        })
        
        this.client = redis.createClient()
        this.sampleTime = sampleTime
        this.maxSamples = Math.floor(3600 / sampleTime)
        this.history = {}
        this.syncing = true
        
        setInterval(this.pubVol.bind(this), 60000)
    }
    
    update(symbol, price) {
        if (typeof price === "string") {
            price = parseFloat(price)
        }
        if (this.history[symbol] === undefined) {
            this.history[symbol] = [ price ]
        } else {
            this.history[symbol].push(price)
            this.history[symbol] = this.history[symbol].slice(-this.maxSamples)
        }
        if (!this.syncing) {
            this.client.publish(symbol, JSON.stringify({
                type: "tick",
                uuid: this.uuid,
                tick: price
            }))
        }
    }

    pubVol() {
        Object.keys(this.history).map(key => {
            const vol = DataFeedProducer.computeVol(this.history[key], this.sampleTime, TARGETVOLWINDOW)
            this.client.publish(key, JSON.stringify({
                type: "vol",
                uuid: this.uuid,
                vol: vol
            }))
        })
    }
    
    /*
     * Volatility calculation for a data array
     *   
     *   Volatility is defined as the std deviation of log returns
     *
     *   data - input data array of samples in reverse time order (oldest first)
     *   dataInterval - interval of time between input data array samples
     *   
     *   targetInterval - interval of time for volatility calculation
     *   sampleWindow (optional) - window of time for volatility calculation
     *     if not specified, use full data array
     *
     */
    static computeVol(data, dataInterval, targetInterval, sampleWindow) {
        let samples = data
        
        if (sampleWindow !== undefined) {
            const length = Math.floor(sampleWindow / dataInterval)
            samples = data.slice(Math.max(data.length - length, 0))
        }

        // Compute log returns
        var logReturns = []
        for (var i = 0; i < samples.length - 1; i++) {
            const index = samples.length - i - 1
            logReturns.push(Math.log(1 + (data[index] - data[index - 1]) / data[index - 1]))
        }

        // Compute volatility
        var avg = 0
        for (var i = 0; i < logReturns.length; i++) {
            avg += logReturns[i]
        }
        avg /= logReturns.length
        var std = 0
        for (i = 0; i < logReturns.length; i++) {
            std += Math.pow(logReturns[i] - avg, 2)
        }
        std = Math.sqrt(std / logReturns.length)
        return std * Math.sqrt(targetInterval / dataInterval)
    }

}

export class DataFeedConsumer extends SystemNode {
    
    constructor(name) {
        super(name, DATA_CONSUMER, intro => {
            if (intro.type === DATA_PRODUCER) {
                this.trackPeer(intro, () => {
                    console.log("OFFLINE: " + intro)
                })
            }
        })
        this.client = redis.createClient()
        this.client.on("message", this.messageHandler.bind(this))
        this.latest = {}
    }
    
    doStats() {
        setInterval(this.stats.bind(this), 60000)
    }
    
    subscribeTicker(ticker) {
        this.client.subscribe(ticker)
    }
    
    messageHandler(channel, message) {
        const obj = JSON.parse(message)
        
        if (this.latest[obj.uuid] === undefined) {
            this.latest[obj.uuid] = {}
        }
        if (this.latest[obj.uuid][channel] === undefined) {
            this.latest[obj.uuid][channel] = {}
        }
        
        // Tick message
        if (obj.type === "tick") {
            this.latest[obj.uuid][channel].tick = obj.tick
            if (this.tickCallback !== undefined) {
                this.tickCallback(this.peers[obj.uuid].name, channel, obj.tick)
            }
        }
        
        // Vol message
        if (obj.type === "vol") {
            this.latest[obj.uuid][channel].vol = obj.vol
            if (this.volCallback !== undefined) {
                this.volCallback(this.peers[obj.uuid].name, channel, obj.vol)
            }
        }
        
        if (this.rawCallback !== undefined) {
            this.rawCallback(message)
        }
    }
    
    stats() {
        const latest = {}
        const avg = {}
        const vol = {}
        
        const peers = Object.keys(this.peers)
        for (var i=0; i<peers.length; i++) {
            const peer = peers[i]
            
            // filter out inactive peers
            if (this.latest[peer] !== undefined) {
                latest[peer] = this.latest[peer]
                
                const syms = Object.keys(latest[peer])
                for (var j=0; j<syms.length; j++) {
                    const sym = syms[j]
                    const data = latest[peer][sym]
                    
                    if (data.tick !== undefined) {
                        if (avg[sym] === undefined) {
                            avg[sym] = {
                                value: data.tick,
                                count: 1
                            }
                        } else {
                            avg[sym].value += data.tick
                            avg[sym].count++
                        }
                    }
                    
                    if (data.vol !== undefined) {
                        if (vol[sym] === undefined) {
                            vol[sym] = {
                                lo: data.vol,
                                hi: data.vol
                            }
                        } else {
                            vol[sym].hi = Math.max(vol[sym].hi, data.vol)
                            vol[sym].lo = Math.min(vol[sym].lo, data.vol)
                        }
                    }
                }
            }
        }
        this.latest = latest
        
        // Compute averages
        const allKeys = Object.assign(Object.keys(avg), Object.keys(vol))
        allKeys.map(key => {
            const stats = {}
            if (avg[key] !== undefined) {
                stats.average = avg[key].value / avg[key].count
            }
            if (vol[key] !== undefined) {
                stats.vol = (vol[key].hi + vol[key].lo) / 2
            }
            if (this.statsCallback !== undefined) {
                this.statsCallback(key, stats)
            }
        })
    }
    
}
