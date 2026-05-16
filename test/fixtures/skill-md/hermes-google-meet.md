---
name: google_meet
description: Schedule, join, and summarize Google Meet calls from a Hermes session.
version: 1.2.0
author: Hermes Team
license: MIT
platforms:
  - hermes
metadata:
  hermes:
    tags:
      - calendar
      - meetings
      - google
    related_skills:
      - google_calendar
      - meeting-notes
---

# google_meet

Tool integration for Google Meet. Note the underscore in the name — slugify should rewrite it to `google-meet` on import.

## Scheduling

Uses the Google Calendar API to create events with auto-generated Meet links.

## Joining

Opens the meet URL via the host's default browser.

## Summarizing

Pulls the call transcript (when enabled by the meeting owner) and produces a structured summary with action items.
