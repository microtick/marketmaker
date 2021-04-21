# Microtick Market Making Toolkit

The purpose of this repository is to provide a more robust implementation of a market maker that is open sourced and allows anyone to download, modify and use
without restriction.

## Review and Basic Strategy

### Dynamic Quotes

It's easy to understand that for puts, the higher the strike price is, the more valuable the option will be, because the strike price translates to the price
the buyer of the option can sell the underlying asset at.  Similarly, for calls, the lower the strike price is, the more valueable the option is to the buyer.

Microtick is based on a real-time average consensus price of many bi-directional quotes

The way dynamic quotes work in Microtick is based on a linear approximation of the change in premium per unit change in spot (known as the "delta"). Specifically,
the delta for an at-the-money put is 0.5, meaning the fair value premium will go up by 1 unit for every 2 unit change in strike price.  The delta for an 
at-the-money call is -0.5, meaning the fair value premium will drop by 1 unit for every 2 unit positive change in strike. (If this were not the case, there 
would be an arbitrage opportunity when the consensus moved by capitalizing on the difference between a synthetic long or short, and trading the underlying asset.
This is an exercise left for the reader.)

This operation is diagramed in the figure below, where the market's consensus price has risen above the quote's spot price. This change in consensus price causes
the quote's put premium to _increase_, and the call premium to _decrease_, at the linear delta of +/- 0.5, respectively. This behavior automatically compensates
the quote provider for a change in consensus, without requiring the quoted spot or premium to be changed. This dynamic adjustment is automatic and realtime, and is programmed into the on-chain smart contract logic for Microtick.

In the diagram:

```
The consensus spot price has moved higher (A)...
   ... causing the call and put premiums to adjust based on the option deltas (B)...
   ... resulting in a higher put premium and lower call premium for the quote (C)
   (until it gets re-adjusted by the market maker)
```

![Dynamic quote](/docs/Dynamic%20Quote%20Adjustment.svg)

### Market Making Strategy

Because of the way Dynamic Quotes operate, the market making strategy for Microtick should be as follows:

1. Market maker computes a fair value for option premium based on real-world observed volatility.
2. Market maker marks up the premium by some amount to create a margin-of-error window within which the dynamic premium will remain above fair value for both puts and calls, as long as the consensus price stays within the margin window.
3. When the consensus price or the real-world price changes outside the margin range, rebase the quoted spot (and optionally the premium as well) to recenter the quote.

![Market making strategy](/docs/Market%20Making%20Strategy.svg)

## Toolkit Operation

The toolkit is designed to be modular, with all functional blocks communicating using a discovery protocol built on top of redis pub/sub messaging.

### Price Feeds

Multiple price feeds can be constructed using the existing price feed components as a model. Currently Kraken and Coincap are supported. If you write
a new price feed, please create a PR and add it to the repository!

![Toolkit functional diagram](/docs/Toolkit%20Functional%20Diagram.svg)

### Aggregator

The aggregator module keeps track of the currently live price feeds and averages the latest price samples from each feed for a particular market. The
mapping of price feed to a standard market symbol (i.e. ETHUSD is "ethereum" on coincap and XETHZUSD in Kraken) is handled in the price feed.

Note that discovery protocol is designed to allow any module to be stopped / restarted without affecting the system operation. This means you can add
or stop price feeds at any time, even during live operation and the aggregator module will handle the averaging appropriately.

### Option Pricer

The option pricer takes the aggregated feed and calculates the real-time short-term volatility at 1-minute intervals. It then messages out the aggregated
spot price and the calculated fair value premiums for each market on the appropriate channel.

### Market Maker

The market maker monitors the real-time price information and the option pricer output, and uses these events to manage on-chain quotes for each market.
This market maker module can handle multiple markets from a single hot wallet, making managing funds across wallets much easier.

The customizable parameters for the market maker are as follows (set in config.json):

* minBalance (default 1000): This is the minimum balance required before the market maker will start. If there are not enough funds, a message is printed
on the console and the system will recover by simply depositing the required funds to the hot wallet (no restart required).
* staticMarkup (default 1.5): This is the markup mentioned in the "Market Making Strategy" section above. A setting of 1.5 means 50% will be added to the fair value (i.e. if fair value is 8, the market maker will place quotes at 12)
* dynamicMarkup (default  0.5): This parameter allows you to set the sensitivity of premiums to open interest in the market. A setting of 0.5 means that if all
the quote backing for this duration is traded off the market and is active in trades, then another 25% will be added to the premiums. This is linear, so if 
there is twice the premium allocated for backing currently active in trades, then

in progress

  "premiumThreshold": 1,
  "staleFraction": 0.5,
  "targetBacking": {
    "300": 200,
    "900": 250,
    "3600": 100
  },
  "minBacking": 25,
  "maxBacking": 40,
