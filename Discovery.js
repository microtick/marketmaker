import redis from 'redis'
import { v4 as uuidv4 } from 'uuid'

const DISCOVERY = "microtick-discovery"
const ANNOUNCE_INTERVAL = 10000

const DEFAULT_LOGGING = true

export default class SystemNode {
    
    constructor(name, type, discovery_cb) {
        this.uuid = uuidv4()
        this.start = Date.now()
        this.peers = {}
        this.logging = DEFAULT_LOGGING
        
        // Discovery subscriber
        this.subClient = redis.createClient()
        this.subClient.subscribe(DISCOVERY)
        this.subClient.on("message", (chan, msg) => {
            if (chan === DISCOVERY) {
                const obj = JSON.parse(msg)
                if (obj.uuid !== this.uuid) {
                    if (discovery_cb !== undefined) discovery_cb(obj)
                }
            } else {
                // Uptime monitoring
                if (chan !== this.uuid) {
                    clearTimeout(this.peers[chan].timeout)
                    this.peers[chan].timeout = setTimeout(
                        this.peerTimeout.bind(this, chan),
                        ANNOUNCE_INTERVAL * 1.5
                    )
                }
            }
        })
        
        // Discovery publisher
        this.pubClient = redis.createClient()
        this.intro = JSON.stringify({
            name: name,
            uuid: this.uuid,
            type: type
        })
        this.pubClient.publish(DISCOVERY, this.intro)
        
        setInterval(() => {
            const uptime = (Date.now() - this.start) / 1000
            this.pubClient.publish(this.uuid, uptime)
        }, ANNOUNCE_INTERVAL)
    }
    
    reannounce() {
        if (this.logging) {
            console.log("reannouncing: " + this.intro)
        }
        this.pubClient.publish(DISCOVERY, this.intro)
    }
    
    trackPeer(intro) {
        if (this.peers[intro.uuid] === undefined) {
            if (this.logging) {
                console.log("Adding peer: " + intro.name + " " + intro.uuid)
            }
            this.subClient.subscribe(intro.uuid)
            this.peers[intro.uuid] = {
                name: intro.name,
                type: intro.type,
                timeout: setTimeout(
                    this.peerTimeout.bind(this, intro.uuid),
                    ANNOUNCE_INTERVAL * 1.5
                )
            }
        }
    }
    
    peerTimeout(uuid) {
        this.subClient.unsubscribe(uuid)
        delete this.peers[uuid]
        if (this.logging) {
            console.log("Peer disconnected: " + uuid)
        }
    }
    
}
