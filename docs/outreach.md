# First five installs — what to send

Send this to developers you know who have a TypeScript repo that uses Stripe.
One at a time, personally. Not a broadcast.

---

Subject: would you run this on your Stripe code for a month?

Hi <name>,

I built a small GitHub Action and I'm looking for five people to run it on a real repo
for a month. No signup, no server, nothing leaves your CI.

It reads your code, works out which Stripe fields and webhooks you actually use, watches
Stripe's published API spec, and opens an issue (with file and line) only when a change
touches something you use. It never changes your code.

Install is one workflow file: https://github.com/Gautam121212/arcdrip#install
To see it work in two minutes without waiting for Stripe, there's a replay of a real 2025
breaking change in the README.

What I'd ask in return: leave it running, and tell me when it's wrong, noisy, or unclear —
that's the only feedback that matters right now. If it catches something real, I'd love to
write that up (with your permission).

Thanks,
<you>

---

## What to record for each install

- repo type (SaaS, marketplace, internal tool), rough size, TS or JS
- did the first run succeed; how many entries (t1/t2/t3) it found
- every alert: was it right, was it useful, was the issue clear
- any run that failed or produced a ::warning::
- after four weeks: are they still running it, and what did they ask for next

That last line is the provider roadmap and the pricing research.
