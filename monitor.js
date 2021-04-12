import { DataFeedConsumer } from './DataFeed.js'

class Monitor extends DataFeedConsumer {
    
    constructor() {
        super("monitor")
    }
    
    rawCallback(message) {
        console.log(JSON.stringify(message))
    }
    
}

const monitor = new Monitor()
//monitor.subscribeTicker("XBTUSD")
monitor.subscribeTicker("ETHUSD")
