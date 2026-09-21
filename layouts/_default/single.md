# {{ .Title }}

- **Author**: {{ .Site.Params.author }}
- **Date**: {{ .Date.Format "2006-01-02" }}
- **URL**: {{ .Permalink }}
{{ with .Params.tags }}- **Tags**: {{ delimit . ", " }}{{ end }}

{{ .RawContent }}
