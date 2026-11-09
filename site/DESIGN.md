# Design notes for opsifier.com

## Brief

Subject: Opsifier, an open-source control panel for your own server. Audience: developers and small teams who run their own servers. The site's job: say what it is, show it, be straight about how early it is, and send people to the code.

## Concept

Three candidates, each tied to something only this product has:

| Concept | Anchor | Originality | Fit | Feasible | Portable |
| --- | --- | --- | --- | --- | --- |
| The page is a deployment that ends on "All clear" | The panel's six-state lamps and its "All clear" summary | 4 | 5 | 5 | 1 |
| A ring that closes as you read | The logo is the panel's gauge | 3 | 4 | 5 | 3 |
| Words typed into a running service | The name, "ops" turned into a verb | 2 | 3 | 4 | 4 |

Chosen: the first. The gauge from the second is kept inside it.

```
Idea:        The page is a deployment. It opens on a board of mixed lights and ends on "All clear".
Metaphor:    A control board that settles.
Signature:   The lamp board, driven by scroll through one variable.
Emotion:     A question, then calm.
Motion verb: Settle. Things arrive and hold still.
Screenshot:  "Is everything running?" beside a board of lights.
```

The motion rule comes straight from the panel's own: only work in progress moves. At rest, the turning lamps are the only thing moving, and once all is clear nothing moves at all. That stillness is the point, and it is a decision.

## System

- Palette: the product's. Ground navy `#16264A`, deep navy `#0F1B36`, white, paper `#F6F7FA`, amber `#E3A33A`, and the state colours from the panel's `theme.css`.
- Type: Poppins for words, IBM Plex Mono for machine values, the same split as the panel.
- Grid: 12 columns. Radius: 4px, as in the panel.
- Ease: the panel's `cubic-bezier(0.2, 0.7, 0.2, 1)`.
- Sections use different layouts: poster hero, heading rail with a bleeding screenshot, ruled list, image and text, single large value, tabs, terminal, two lists.

## Generic test

A generic answer would be a centered hero, a gradient and three feature cards. Here the hero is a question answered by the product's own state language, the feature list is drawn like the panel's rows, and there are no cards.
