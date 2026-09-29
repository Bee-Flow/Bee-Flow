---
title: Maps
---

# Maps

Google Maps integration for location lookup and directions.

## Setup

1. Enable **Maps JavaScript API**, **Places API**, and **Directions API** in your Google Cloud project.
2. Create an API key restricted to those APIs + your `PUBLIC_URL`.
3. Set environment:
   ```bash
   GOOGLE_MAPS_API_KEY=<key>
   ```

## Tools

| Tool | Purpose |
|------|---------|
| `maps_search_places` | Find places by name + region. |
| `maps_get_place_details` | Address, opening hours, rating, photos. |
| `maps_directions` | Driving / walking / transit directions. |
| `maps_distance_matrix` | Distance + duration between many points. |
| `maps_geocode` | Address → lat/lng. |
| `maps_reverse_geocode` | lat/lng → address. |

## Use cases

- "Find a vegetarian restaurant near my office, open after 19:00."
- "Time from the office to the airport at 16:30 next Tuesday by transit."
- (Automation) For a calendar event with a location, append a Google Maps link.

## Embedded map preview

When `maps_search_places` returns, the SPA renders an embedded map in the conversation using the **MapEmbedRenderer** component.

## Cost notes

Google Maps charges per call. Bee Flow caches search + geocode results for 24h to keep bills low. For high-volume automations, monitor billing.
