---
title: "Handoff: <title>"
type: handoff
profile: new-session
project: <project>
status: draft
created: <date>
acceptance: "<one-paragraph acceptance sentence>"
verify: []
time-budget-min: 60
trust: 0.8
primary-domain: <project>
lifecycle: active
related: []
tags: [type/handoff, profile/new-session, status/draft, project/<project>]
---

# Handoff: <title>

> [!info]
> Profile: **new-session** · Project: **<project>** · Created: **<date>**
> Paste this entire file (or just the activation phrase at the bottom) into a fresh agent session as the opening message.

## What we were doing

_(State of play. What got done before this handoff. Cross-link to prior result/retro.)_

## What's in scope

_(One paragraph + bullet checklist.)_

## State snapshot

@CONTINUATION
branch="main"
last_commit=""
modified_files=[]
in_flight=[]
pushed_to_remote=true
remote=""
test_count=0

## Sources

@SOURCES
required=[]
optional=[]

## Resume command

> 1. Read every source under @SOURCES.required in full before drafting any plan.
> 2. ...

## Sign-off

> [!warning]
> Retro file is canonical. Write retro to `<vault>/Handoffs/<project>/retros/<date>-<slug>-retro.md`.

## Activation phrase

```
/handoff-execute "<absolute-path-to-this-brief>"
```
