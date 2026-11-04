# Caddy mit Cloudflare-DNS-Modul: holt Let's-Encrypt-Zertifikate per DNS-01 (ohne offenen Port 80)
FROM caddy:2.10-builder AS builder
# Das Modul braucht ggf. eine neuere Go-Version als das Image mitbringt
ENV GOTOOLCHAIN=auto
RUN xcaddy build --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:2.10-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
