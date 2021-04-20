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

Because of the way Dynamic Quotes operate, the market making strategy for Microtick is typically as follows:

1. Compute a fair value for option premium based on the real-world observed volatility.
2. Mark up the premium by some amount to create a margin-of-error window within which the dynamic premium will remain above fair value for both puts and calls.
3. When the consensus price or the real-world price changes, rebase the quoted spot to recenter the quote.

![Market making strategy](/docs/Market%20Making%20Strategy.svg)

## Toolkit Operation

