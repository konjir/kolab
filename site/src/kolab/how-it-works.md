# Kolab in five minutes

Kolab keeps what your software should do and the code built from it in step.

## The problem

What a team means lives in many places: a wiki page, a ticket, the code. They drift apart. A requirement changes, and the code written against it never hears. Hand an agent an ambiguous ticket and it guesses and keeps going.

## A kolab, its spec and its bindings

Kolab is the server, at `kolab.konjir.com`. A **kolab**, lowercase, is one project in it: an agent working in one sees only what is inside it. A kolab holds:

- **The spec**: what the software does, in plain words, one requirement to an element. People working as **product** write it.
- **A binding**: how the spec is built, its technical decisions and the work left to do. People working as **engineer** write it. Each element links to the requirements it serves, pinned to the text it was checked against.

The spec is the functional layer, a binding the technical one. Every element has an **address** that keeps pointing at it through every edit: `kj:checkout@3#R1` is requirement `R1` in version 3 of the `checkout` spec.

## Every change is a version

A change is a new version, and it commits once someone other than its author approves it, or on Kolab's checks alone when no one else may. By default only a person approves a version of the spec.

## People and their agents

The people in a kolab are its actors, and so are their agents. Each agent belongs to a person and gets no more access than that person holds. Each works as product or as engineer, and can't edit the other layer: when it needs something across that line, it asks. The answer is kept as precedent, so a settled question isn't asked twice.

Agents connect over MCP, from Claude Code or any MCP client.

## Work packages and kolab work

A **work package** is an element of a binding that says what to build and when it is done. It is ready once its binding is committed and nothing open or unfinished blocks it.

`kolab work`, signed in as yourself, in a checkout of the repository registered in your kolab, sets your machine to work. It takes each item, a review, a ready work package, a question or a mark, as a job for one of your agents, which does that one item and exits. No agent reviews its own work, and no job merges or deploys: those stay yours.

## Marks

When a version commits, exactly the elements that relied on the old text are **marked** stale, each with a word-by-word diff. Every other link moves to the new version unmarked. One change, start to finish:

1. Maya, working as product, changes a requirement in a new version of the spec.
2. Someone other than Maya approves it, and it commits (on Kolab's checks alone, if no one else may approve).
3. Kolab marks the binding elements and work packages that relied on that requirement, and nothing else.
4. Sam, as engineer, or his agent, checks each mark against the new text: if the element still holds, he clears the mark; if not, he revises it.
5. A finished work package whose code no longer holds is reopened, and `kolab work` builds it again.

## Kolab's web page

Sign in at [kolab.konjir.com](https://kolab.konjir.com/) with GitHub. It opens on your **Inbox**: what only your layer can settle. Beside it:

| Part | What it's for |
| --- | --- |
| **Working as** | Who you are, and your role, product or engineer, which you can switch |
| **Reviews** | **Waiting for your review**, **What you submitted** and **What your agents reviewed**: versions and work packages |
| **Questions** | Open questions, each waiting on the layer that answers it, and answered ones, kept as precedent |
| **Work** | Every work package on a board, from To do to Done, with what is ready, blocked or at risk |

## Where to go next

- [Try it hands-on](/kolab/hands-on/): write a spec, then build it with a team of agents, in about an hour.
- Install the CLI, `npm i -g @konjir/kolab`, then see [Kolab's page](/kolab/).
- [Sign up with GitHub](https://kolab.konjir.com/api/session/oauth/start).
