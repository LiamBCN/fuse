#!/bin/bash
# One-time, NON-INTERACTIVE setup of a STABLE self-signed code-signing identity
# for Fuse, kept in a dedicated keychain whose password this script owns - so
# codesign never has to prompt you.
#
# Why: deploys otherwise sign the app ad-hoc, whose identity (cdhash) changes on
# every rebuild. macOS then treats each build as a new app and forgets every
# folder you allowed - re-prompting after each deploy. A stable cert keeps the
# identity constant so folder / Full-Disk-Access grants persist across builds.
#
# Idempotent: safe to run repeatedly (deploy.sh calls it every time).
set -e
CN="Fuse Local Signing"
KC="$HOME/Library/Keychains/fuse-signing.keychain-db"
KCPW="fuse-local-signing"   # protects only this throwaway signing cert; not sensitive
LOGIN="$HOME/Library/Keychains/login.keychain-db"

# Remove any earlier copy in the login keychain (avoids "ambiguous identity").
for H in $(security find-certificate -a -c "$CN" -Z "$LOGIN" 2>/dev/null | awk '/SHA-1/{print $3}'); do
  security delete-certificate -Z "$H" "$LOGIN" 2>/dev/null || true
done

# Create / unlock the dedicated keychain.
if [ ! -f "$KC" ]; then
  security create-keychain -p "$KCPW" "$KC"
fi
security set-keychain-settings "$KC"        # no auto-lock timeout
security unlock-keychain -p "$KCPW" "$KC"

# Create the identity if it isn't there yet.
if ! security find-identity -p codesigning "$KC" 2>/dev/null | grep -q "$CN"; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  cat > "$TMP/codesign.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_codesign
[dn]
CN = Fuse Local Signing
[v3_codesign]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -days 7300 -config "$TMP/codesign.cnf"
  # -legacy so Apple's `security` can import it (OpenSSL 3's default MAC isn't readable by it).
  openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -out "$TMP/fuse.p12" -passout pass:fuse -name "$CN"
  security import "$TMP/fuse.p12" -k "$KC" -P fuse -T /usr/bin/codesign -A
  # Let codesign use the key with NO prompt (we own this keychain's password).
  security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPW" "$KC" >/dev/null
  echo "Created identity '$CN' in dedicated keychain."
else
  echo "Identity '$CN' already present."
fi

# Ensure the dedicated keychain is on the search list so codesign can find it.
# (Portable to macOS's bash 3.2 - no mapfile.)
LIST=()
while IFS= read -r line; do
  line="$(printf '%s' "$line" | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//')"
  [ -n "$line" ] && LIST+=("$line")
done < <(security list-keychains -d user)
FOUND=0; for k in "${LIST[@]}"; do [ "$k" = "$KC" ] && FOUND=1; done
if [ "$FOUND" -eq 0 ]; then
  security list-keychains -d user -s "${LIST[@]}" "$KC"
  echo "Added dedicated keychain to search list."
fi
echo "Signing identity ready: $CN"
