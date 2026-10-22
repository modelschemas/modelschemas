---
'@modelschemas/client': patch
---

Type the model row. `listModels`, `listProviderModels`, `getModel` and the
admin export now return typed rows (`Model`, `ModelList`,
`ProviderModelList`, `ModelDetail`, `ExportModel`) instead of
`{ [key: string]: unknown }`: every field is required except `factSources`
(omitted with `provenance=0`), with `modalities`, `factSources`, `_links`
and detail `discrepancies` spelled out. Adds the `catalog.shape_changed`
change type: the feed announces each new row shape version.
