import redis from 'redis'

import { DataFeedConsumer } from './DataFeed.js'

const durs = [ 300, 900, 3600, 14400, 43200 ]

class MarketMaker extends DataFeedConsumer {
    
    constructor() {
        super("marketmaker")
        
        this.mmClient = redis.createClient()
        this.lasttick = {}
        this.lastvol = {}
        this.doStats()
    }
    
    addMarket(symbol) {
        this.subscribeTicker(symbol)
    }
    
    statsCallback(symbol, stats) {
        if (stats.average !== undefined) {
            this.lasttick[symbol] = stats.average
        }
        if (stats.vol !== undefined) {
            this.lastvol[symbol] = stats.vol
        }
        this.checkQuotes(symbol)
    }
    
    checkQuotes(symbol) {
        if (this.lasttick[symbol] !== undefined && this.lastvol[symbol] !== undefined) {
            const opt = this.calculateOptions(symbol)
            console.log(JSON.stringify(opt))
            this.mmClient.publish(symbol, JSON.stringify({
                type: "microtick",
                action: "quote",
                uuid: this.uuid,
                spot: this.lasttick[symbol],
                premium: this.lastvol[symbol]
            }))
        }
    }
    
    calculateOptions(symbol) {
        const options = []
        for (var i=0; i<durs.length; i++) {
            const dur = durs[i]
            const obj = this.blackscholes(this.lasttick[symbol], this.lasttick[symbol], this.lastvol[symbol], dur / 900, 0)
            options.push((obj.call + obj.put) / 2)
        }
        return options
    }
    
    erf(x) {
        // save the sign of x
        var sign = (x >= 0) ? 1 : -1;
        x = Math.abs(x);
      
        // constants
        var a1 =  0.254829592;
        var a2 = -0.284496736;
        var a3 =  1.421413741;
        var a4 = -1.453152027;
        var a5 =  1.061405429;
        var p  =  0.3275911;
      
        // A&S formula 7.1.26
        var t = 1.0/(1.0 + p*x);
        var y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
        return sign * y; // erf(-x) = -erf(x); 
    }
    
    cdf(x, mean, variance) {
        return 0.5 * (1 + this.erf((x - mean) / (Math.sqrt(2 * variance))))
    }
      
    ln(x) {
        return Math.log(x)
    }
      
    blackscholes(spot, strike, vol, T, r) {
        // OP = S * N(d1) - X * exp(-r * t) * N(d2)
        // d1 = (ln(S/X) + (r + v^2/2) * t) / (v * sqrt(t))
        // d2 = d1 - v * sqrt(t)
        // S = spot price
        // X = strike price
        // t = time remaining, percent of a year
        // r = risk-free interest rate, continuously compounded
        // v = annual volatility (std dev of short-term returns over 1 year)
        //      square root of the mean of the squared deviations of close-close log returns
        if (vol > 0) {
          var d1 = (this.ln(spot / strike) + (r + vol * vol / 2.0) * T) / (vol * Math.sqrt(T));
        } else {
          d1 = 0
        }
        var d2 = d1 - vol * Math.sqrt(T);
        var C = spot * this.cdf(d1, 0, 1) - strike * this.cdf(d2, 0, 1) * Math.exp(-r * T);
        var P = C - spot + strike * Math.exp(-r * T);
        return { call: C, put: P };    
    }
    
}

const marketmaker = new MarketMaker()
marketmaker.addMarket("ETHUSD")
