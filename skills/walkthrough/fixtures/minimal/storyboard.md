# Storyboard: Lendhand tool-library loan (CI fixture)

Persona: Maya Okafor, a member who needs a drill for the weekend. Theo Brandt is the volunteer at the desk.
The job: borrow a tool, collect it, bring it back. Fictional app, fictional people.

Closing principle: **Borrow it. Bring it back.**

Runtime: 13 + 13 + 12 + 14 + 10 = 62 s. Five scenes, three to four beats each (the recap has one).

| # | Scene | Length | Beats | Mirrors | Hidden on narrow |
|---|---|---|---|---|---|
| 1 | Browse | 13 s | search, narrowing, cards show availability | `Browse.tsx` | the sub-heading |
| 2 | Reserve | 13 s | open the drill, pick Sat to Sun, Reserve | `Reserve.tsx` | the description |
| 3 | Pick up | 12 s | pickup pass and code, the desk, My loans | `PickupPass.tsx` | none (drawer becomes a bottom sheet) |
| 4 | Return | 14 s | open the loan, three ticks, Check in, counter to zero | `Loans.tsx` | none |
| 5 | Recap | 10 s | the closing card | none | none |

Cast: Maya Okafor, Theo Brandt. No other people, no real data.
