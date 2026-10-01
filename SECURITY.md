# Security

The Foundry API key belongs in `.env` as `AZURE_OPENAI_API_KEY`, or in the environment of the process that runs `npm start`. Do not put it in `config.json`, the usage page, a GitHub issue, a commit, or a screenshot of the terminal.

`.env` is gitignored. `.env.example` is the template and contains no key.

The proxy listens on `127.0.0.1` only. It sends the key in the `api-key` header to the host in `AZURE_OPENAI_ENDPOINT`, and only if that host is allowlisted. Redirects are not followed. Errors and the usage page are redacted before they are written.

If you find a way for the key to leak, or for the proxy to call a host other than the one you configured, report it through GitHub private vulnerability reporting on this repository. Do not include a real key, endpoint, or account id in a public issue.
