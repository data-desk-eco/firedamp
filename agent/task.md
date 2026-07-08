# methane plume source attribution

you are attributing a satellite-detected methane plume to its most likely source. the attached context.json contains the detection plus pre-gathered evidence:

- `plume` — the detection: rate (kg/hr), sensor, date, coordinate, a `sensor_note` saying how far the true source can lie from the coordinate (treat that as your search horizon), and `source_record` — extra provider fields (exact timestamp, plume-mask bounds, the provider's own wind estimate) when available.
- `wind` — surface wind that day (`daily_mean`, plus `at_detection_utc` when the exact hour is known — prefer it). drifted plumes sit DOWNWIND of their source, so for coarse sensors look upwind of the coordinate (`from` is the direction the wind came from). when the sensor_note says the coordinate is the provider's assessed source origin, wind explains drift shape only — never use it to move the source.
- `detection_history` — every other satellite detection nearby from a 4-source archive (carbon mapper, UN IMEO/MARS, SRON/TROPOMI, GHGSat), with distance and bearing. repeat detections clustered on one spot are strong evidence of a persistent source there.
- `ogim` — nearby oil & gas infrastructure from the OGIM v2.7 inventory (wells, compressor stations, processing plants…).
- `osm` — nearby OpenStreetMap features (industrial, mining, waste, energy, agriculture).
- `og_field` — oil/gas field(s) containing the point, if any.
- `coal_mines` — nearby mines from the Global Coal Mine Tracker (output in Mt/yr; underground mines vent far more methane than surface mines).

## tools

- `websearch "query"` — web search (title, url, snippet per result)
- `webget <url>` — fetch a url as readable text
- full tags for an osm feature: `webget https://www.openstreetmap.org/api/0.6/<node|way|relation>/<id>.json`

## method

work like an investigator, not a classifier:

1. form hypotheses from the local evidence: what candidates are within the search horizon, upwind-weighted, with a type and scale that can plausibly emit the observed rate? (a 5 t/hr plume needs a mine ventilation shaft, landfill, gas plant, large well pad or pipeline — not a barn; conversely a 100 kg/hr plume next to a dairy lagoon may well be the lagoon.) respect the sensor's geometry: when the sensor_note says the coordinate is the provider's assessed source origin (carbon mapper, ghgsat, high-res imeo), the source is essentially AT the coordinate — wind explains the plume's drift shape, not a source offset — so a candidate several hundred metres away is not credible however well it fits otherwise, and a big named plant nearby must not steal the attribution from a well or compressor at the coordinate itself; unmapped equipment at the coordinate (check what satellite imagery providers' maps label there) beats a distant named facility. only coarse detections (imeo mixed, tropomi) justify searching kilometres upwind.
2. research each serious candidate on the web: official facility name, operator, status (active/abandoned/under maintenance?), known methane record — search operator + place, place + "methane"/"landfill"/"coal mine"/"blowout", news around the detection date, regulator or company disclosures. non-english sources are often decisive — search in the local language too.
3. cross-check against the detection history: does this spot light up repeatedly? do rates and sensors fit your candidate? a one-off from a precise sensor can be an intermittent event (blowdown, well work); persistent detections mean a persistent source.
4. decide, honestly. if the evidence genuinely doesn't single out a source, say so — a confident "none" beats a plausible guess. never stretch a weak candidate to fill the answer.

## output

when finished, write `result.json` in the working directory:

```json
{
  "source_label": "≤8 plain-english words for a journalist",
  "source_kind": "well|facility|pipeline|mine|landfill|other|none",
  "source_name": "official facility name, or null",
  "operator": "operating company, or null",
  "attributed_id": "OGIM:<ogim_id> or OSM:<node|way|relation>/<id> copied verbatim from context.json, or null",
  "confidence": "high|medium|low",
  "paragraph": "2–5 sentences fit for publication: name the source and the key evidence (proximity, wind, repeat detections, rate consistency, research findings). open with the hedged attribution ('… is the likely source', 'most consistent with …') — never state it as fact.",
  "evidence": ["up to 5 urls that back the attribution"]
}
```

never invent ids — `attributed_id` must appear in context.json (osm ids look like `https://www.openstreetmap.org/node/123`; write `OSM:node/123`). always write result.json, even when the answer is "none".
