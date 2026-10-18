#!/bin/sh

set -eu
umask 077

MANIFEST_URL='https://catbots.fun/releases/stable/manifest.json'
SIGNATURE_URL='https://catbots.fun/releases/stable/manifest.json.sig'
BUNDLE_ID='com.catbots.desktop'
TEAM_ID='CATBOTS_TEAM_ID_REQUIRED'

# This trust root is intentionally compiled into the bootstrap. Release tooling must
# sign manifest.json with the corresponding offline key; no environment variable or
# downloaded file can replace it.
PUBLIC_KEY_PEM='CATBOTS_RELEASE_PUBLIC_KEY_REQUIRED'
PUBLIC_KEY_FINGERPRINT='CATBOTS_RELEASE_TRUST_FINGERPRINT_REQUIRED'
RELEASE_TRUST_STATE='CATBOTS_RELEASE_TRUST_NOT_INJECTED'

CURL='/usr/bin/curl'
OPENSSL='/usr/bin/openssl'
OSASCRIPT='/usr/bin/osascript'
UNAME='/usr/bin/uname'
SW_VERS='/usr/bin/sw_vers'
UNZIP='/usr/bin/unzip'
ZIPINFO='/usr/bin/zipinfo'
CODESIGN='/usr/bin/codesign'
PLUTIL='/usr/bin/plutil'
SPCTL='/usr/sbin/spctl'
STAPLER='/usr/bin/xcrun'
LIPO='/usr/bin/lipo'
MKTEMP='/usr/bin/mktemp'
CHMOD='/bin/chmod'
RM='/bin/rm'
MKDIR='/bin/mkdir'
FIND='/usr/bin/find'
WC='/usr/bin/wc'
TR='/usr/bin/tr'
SHASUM='/usr/bin/shasum'
AWK='/usr/bin/awk'
SED='/usr/bin/sed'

WORK_DIRECTORY=

fail() {
  printf 'Catbots installer: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "$WORK_DIRECTORY" ] && [ -d "$WORK_DIRECTORY" ]; then
    "$RM" -rf -- "$WORK_DIRECTORY"
  fi
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

require_tool() {
  [ -x "$1" ] || fail "required tool is unavailable: $1"
}

download() {
  download_url=$1
  download_output=$2
  "$CURL" --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --fail --silent --show-error --max-redirs 0 \
    --output "$download_output" "$download_url"
}

download_artifact() {
  download_url=$1
  download_output=$2
  effective_url_output=$3
  redirect_headers_output=$4
  "$CURL" --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --fail --silent --show-error --location --max-redirs 5 \
    --output "$download_output" --dump-header "$redirect_headers_output" \
    --write-out '%{url_effective}' "$download_url" \
    > "$effective_url_output"
}

verify_redirect_chain() {
  redirect_headers=$1
  while IFS= read -r redirect_line || [ -n "$redirect_line" ]; do
    case "$redirect_line" in
      [Ll][Oo][Cc][Aa][Tt][Ii][Oo][Nn]:*)
        redirect_url=${redirect_line#*:}
        redirect_url=$(printf '%s' "$redirect_url" | "$SED" 's/^[[:space:]]*//;s/[[:space:]]*$//')
        verify_effective_url "$redirect_url"
        ;;
    esac
  done < "$redirect_headers"
}

verify_github_asset_url() {
  case "$1" in
    https://github.com/catbots-fun/catbots/releases/download/*/*) ;;
    *) fail 'manifest artifact URL is not an immutable Catbots GitHub release asset' ;;
  esac
  case "$1" in *'?'*|*'#'*|*'@'*|*'//'*/../*|*'//'*/./*) fail 'manifest artifact URL is invalid' ;; esac
}

verify_effective_url() {
  case "$1" in
    https://github.com/*|https://objects.githubusercontent.com/*|https://release-assets.githubusercontent.com/*) ;;
    *) fail 'artifact redirect host is not approved' ;;
  esac
  case "$1" in *'#'*|*'@'*) fail 'artifact redirect URL is invalid' ;; esac
}

version_at_least() {
  version_left=$1
  version_right=$2
  "$AWK" -v left="$version_left" -v right="$version_right" 'BEGIN {
    if (left !~ /^[0-9]+\.[0-9]+(\.[0-9]+)?$/ || right !~ /^[0-9]+\.[0-9]+(\.[0-9]+)?$/) exit 2
    split(left, l, "."); split(right, r, ".")
    for (i = 1; i <= 3; i++) { if ((l[i] + 0) > (r[i] + 0)) exit 0; if ((l[i] + 0) < (r[i] + 0)) exit 1 }
    exit 0
  }'
}

verify_archive_paths() {
  archive=$1
  entry_count=0
  entries_file="$WORK_DIRECTORY/archive-entries"
  "$UNZIP" -Z1 "$archive" > "$entries_file" || fail 'archive directory could not be read'
  while IFS= read -r entry || [ -n "$entry" ]; do
    entry_count=$((entry_count + 1))
    case "$entry" in
      ''|/*|*\\*|*'//'*) fail 'archive contains an unsafe path' ;;
      ..|../*|*/..|*/../*|./*|*/./*) fail 'archive contains a traversal path' ;;
      Catbots.app|Catbots.app/*) ;;
      *) fail 'archive contains content outside Catbots.app' ;;
    esac
  done < "$entries_file"
  [ "$entry_count" -gt 0 ] || fail 'archive is empty'
  if "$ZIPINFO" -l "$archive" | "$AWK" '$1 ~ /^l/ { found=1 } END { exit(found ? 0 : 1) }'; then
    fail 'archive contains a symbolic link'
  fi
}

verify_application() {
  verify_application_path=$1
  verify_application_architecture=$2
  [ "$verify_application_architecture" != x64 ] || verify_application_architecture=x86_64
  [ -d "$verify_application_path" ] || fail 'archive does not contain Catbots.app'
  [ -z "$("$FIND" "$verify_application_path" -type l -print -quit)" ] || fail 'application contains a symbolic link'
  [ -z "$("$FIND" "$verify_application_path" -type f -links +1 -print -quit)" ] || fail 'application contains a hard link'
  actual_bundle_id=$("$PLUTIL" -extract CFBundleIdentifier raw -o - "$verify_application_path/Contents/Info.plist") \
    || fail 'bundle identifier is unavailable'
  [ "$actual_bundle_id" = "$BUNDLE_ID" ] || fail 'bundle identifier does not match'
  "$CODESIGN" --verify --deep --strict --verbose=2 "$verify_application_path" \
    || fail 'code signature verification failed'
  signature_details=$("$CODESIGN" --display --verbose=4 "$verify_application_path" 2>&1) \
    || fail 'code signature identity is unavailable'
  actual_team_id=$(printf '%s\n' "$signature_details" | "$SED" -n 's/^TeamIdentifier=//p')
  [ "$actual_team_id" = "$TEAM_ID" ] || fail 'Apple Team ID does not match'
  case "$signature_details" in *'flags='*'(runtime)'*|*'Runtime Version='*) ;; *) fail 'hardened runtime is not enabled' ;; esac
  application_architectures=$("$LIPO" -archs "$verify_application_path/Contents/MacOS/Catbots") \
    || fail 'application architecture is unavailable'
  case " $application_architectures " in *" $verify_application_architecture "*) ;; *) fail 'application architecture does not match' ;; esac
  "$SPCTL" --assess --type execute --verbose=2 "$verify_application_path" \
    || fail 'Gatekeeper rejected the application'
  "$STAPLER" stapler validate "$verify_application_path" \
    || fail 'notarization staple is missing or invalid'
}

write_request() {
  request_file=$1
  request_manifest=$2
  request_signature=$3
  request_archive=$4
  request_effective_url=$5
  "$OSASCRIPT" -l JavaScript - "$request_file" "$request_manifest" "$request_signature" "$request_archive" "$request_effective_url" <<'JXA'
ObjC.import('Foundation');
function run(argv) {
  const requestPath = argv[0];
  const request = {
    schemaVersion: 1,
    manifestPath: argv[1],
    signaturePath: argv[2],
    archivePath: argv[3],
    effectiveArtifactUrl: argv[4]
  };
  const value = $(JSON.stringify(request) + '\n');
  if (!value.writeToFileAtomicallyEncodingError(requestPath, true, $.NSUTF8StringEncoding, null)) throw new Error('request write failed');
}
JXA
  "$CHMOD" 600 "$request_file"
}

run_uninstall() {
  purge=$1
  installed_application="$HOME/Applications/Catbots.app"
  installed_executable="$installed_application/Contents/MacOS/Catbots"
  [ -x "$installed_executable" ] || fail 'Catbots is not installed for this user'
  verify_application "$installed_application" "$(map_architecture)"
  if [ "$purge" = yes ]; then
    "$installed_executable" --installer uninstall --purge-data
  else
    "$installed_executable" --installer uninstall
  fi
}

map_architecture() {
  case "$("$UNAME" -m)" in
    arm64) printf 'arm64\n' ;;
    x86_64) printf 'x64\n' ;;
    *) fail 'unsupported Mac architecture' ;;
  esac
}

requested_version=
uninstall=no
purge=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail '--version requires a semantic version'
      requested_version=$2
      shift 2
      ;;
    --uninstall) uninstall=yes; shift ;;
    --purge-data) purge=yes; shift ;;
    *) fail "unknown option: $1" ;;
  esac
done
[ "$RELEASE_TRUST_STATE" = 'CATBOTS_RELEASE_TRUST_INJECTED' ] \
  || fail 'release trust roots were not injected at build time'
case "$TEAM_ID:$PUBLIC_KEY_PEM:$PUBLIC_KEY_FINGERPRINT" in *REQUIRED*) fail 'release trust roots contain build sentinels' ;; esac
[ "$purge" = no ] || [ "$uninstall" = yes ] || fail '--purge-data requires --uninstall'

for tool in "$CODESIGN" "$PLUTIL" "$SPCTL" "$STAPLER" "$LIPO" "$UNAME" "$FIND" "$SED" "$SHASUM" "$AWK"; do require_tool "$tool"; done

if [ "$uninstall" = yes ]; then
  run_uninstall "$purge"
  exit 0
fi

for tool in "$CURL" "$OPENSSL" "$OSASCRIPT" "$SW_VERS" "$UNZIP" "$ZIPINFO" "$MKTEMP" "$CHMOD" "$RM" "$MKDIR" "$WC" "$TR" "$SHASUM" "$AWK"; do require_tool "$tool"; done

WORK_DIRECTORY=$("$MKTEMP" -d "${TMPDIR:-/tmp}/catbots-install.XXXXXX") \
  || fail 'could not create a private temporary directory'
"$CHMOD" 700 "$WORK_DIRECTORY"
manifest_file="$WORK_DIRECTORY/manifest.json"
signature_file="$WORK_DIRECTORY/manifest.json.sig"
public_key_file="$WORK_DIRECTORY/release-public-key.pem"
archive_file="$WORK_DIRECTORY/Catbots.zip.partial"
effective_url_file="$WORK_DIRECTORY/effective-url"
redirect_headers_file="$WORK_DIRECTORY/redirect-headers"
extract_directory="$WORK_DIRECTORY/extracted"
request_file="$WORK_DIRECTORY/request.json"
installer_result_file="$WORK_DIRECTORY/installer-result.json"

printf '%s' "$PUBLIC_KEY_PEM" > "$public_key_file"
actual_public_key_fingerprint=$(printf '%s' "$PUBLIC_KEY_PEM" | "$SHASUM" -a 256 | "$AWK" '{ print $1 }')
[ "$actual_public_key_fingerprint" = "$PUBLIC_KEY_FINGERPRINT" ] || fail 'embedded release public key fingerprint does not match'
download "$MANIFEST_URL" "$manifest_file"
download "$SIGNATURE_URL" "$signature_file"
"$OPENSSL" dgst -sha256 -verify "$public_key_file" -signature "$signature_file" "$manifest_file" \
  >/dev/null 2>&1 || fail 'manifest signature verification failed'

architecture=$(map_architecture)
bundle_architecture=$architecture
[ "$bundle_architecture" != x64 ] || bundle_architecture=x86_64
manifest_values=$("$OSASCRIPT" -l JavaScript - "$manifest_file" "$architecture" <<'JXA'
ObjC.import('Foundation');
function run(argv) {
  const path = argv[0], architecture = argv[1];
  const text = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null));
  const manifest = JSON.parse(text);
  const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === names.slice().sort().join(',');
  const top = ['schemaVersion','releaseId','version','commit','publishedAt','minimumMacOS','bundleId','teamId','protocolVersion','dataSchemaVersion','artifacts'];
  const artifactNames = ['url','sha256','bytes'];
  if (!exact(manifest, top) || manifest.schemaVersion !== 1 || !exact(manifest.artifacts, ['arm64','x64'])
      || !exact(manifest.artifacts.arm64, artifactNames) || !exact(manifest.artifacts.x64, artifactNames)) throw new Error('schema');
  const version = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
  const macOS = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?$/;
  const releaseId = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\+[a-f0-9]{6,64}$/;
  if (!releaseId.test(manifest.releaseId) || !version.test(manifest.version)
      || manifest.releaseId.indexOf(manifest.version + '+') !== 0 || !/^[a-f0-9]{6,64}$/.test(manifest.commit)
      || manifest.releaseId !== manifest.version + '+' + manifest.commit || !macOS.test(manifest.minimumMacOS)
      || manifest.bundleId !== 'com.catbots.desktop' || !/^[A-Z0-9]{5,16}$/.test(manifest.teamId)
      || !Number.isSafeInteger(manifest.protocolVersion) || manifest.protocolVersion < 1
      || !Number.isSafeInteger(manifest.dataSchemaVersion) || manifest.dataSchemaVersion < 0
      || Number.isNaN(Date.parse(manifest.publishedAt))) throw new Error('fields');
  for (const name of ['arm64','x64']) {
    const a = manifest.artifacts[name];
    if (typeof a.url !== 'string' || /[\u0000-\u0020]/.test(a.url) || !/^[a-f0-9]{64}$/.test(a.sha256)
        || !Number.isSafeInteger(a.bytes) || a.bytes < 1) throw new Error('artifact');
  }
  const artifact = manifest.artifacts[architecture];
  return [manifest.releaseId, manifest.version, manifest.minimumMacOS, manifest.bundleId, manifest.teamId,
    String(manifest.protocolVersion), String(manifest.dataSchemaVersion), artifact.url, artifact.sha256, String(artifact.bytes)].join('\t');
}
JXA
) || fail 'manifest JSON or schema is invalid'

tab=$(printf '\tX')
tab=${tab%X}
IFS="$tab" read -r release_id release_version minimum_macos manifest_bundle_id manifest_team_id protocol_version data_schema_version artifact_url artifact_sha256 artifact_bytes <<EOF
$manifest_values
EOF
[ "$manifest_bundle_id" = "$BUNDLE_ID" ] || fail 'manifest bundle identifier does not match'
[ "$manifest_team_id" = "$TEAM_ID" ] || fail 'manifest Apple Team ID does not match'
[ -z "$requested_version" ] || [ "$requested_version" = "$release_version" ] || fail 'requested version is not the signed stable release'
current_macos=$("$SW_VERS" -productVersion) || fail 'macOS version is unavailable'
version_at_least "$current_macos" "$minimum_macos" || fail 'this macOS version is unsupported'
verify_github_asset_url "$artifact_url"

download_artifact "$artifact_url" "$archive_file" "$effective_url_file" "$redirect_headers_file"
"$TR" -d '\r' < "$redirect_headers_file" > "$redirect_headers_file.normalized"
verify_redirect_chain "$redirect_headers_file.normalized"
effective_url=$("$TR" -d '\r\n' < "$effective_url_file")
verify_effective_url "$effective_url"
actual_bytes=$("$WC" -c < "$archive_file" | "$TR" -d ' ')
[ "$actual_bytes" = "$artifact_bytes" ] || fail 'artifact byte length does not match manifest'
actual_sha256=$("$SHASUM" -a 256 "$archive_file" | "$AWK" '{ print $1 }')
[ "$actual_sha256" = "$artifact_sha256" ] || fail 'artifact SHA-256 does not match manifest'

verify_archive_paths "$archive_file"
"$MKDIR" -m 700 "$extract_directory"
"$UNZIP" -q "$archive_file" -d "$extract_directory" || fail 'archive extraction failed'
staged_application="$extract_directory/Catbots.app"
verify_application "$staged_application" "$bundle_architecture"
write_request "$request_file" "$manifest_file" "$signature_file" "$archive_file" "$effective_url"

"$staged_application/Contents/MacOS/Catbots" --installer reconcile "$request_file" > "$installer_result_file" \
  || fail 'signed Catbots installer command failed'
installer_state=$("$OSASCRIPT" -l JavaScript - "$installer_result_file" "$release_id" <<'JXA'
ObjC.import('Foundation');
function run(argv) {
  const text = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null));
  const result = JSON.parse(text);
  const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === names.slice().sort().join(',');
  const healthKeys = ['product','bundleId','releaseId','version','commit','architecture','protocolVersion','dataSchemaVersion','instanceId','readiness','resumePolicy'];
  const stoppedKeys = ['product','bundleId','state'];
  if (!exact(result, ['kind','operationId','releaseId','health']) || result.kind !== 'installed'
      || result.releaseId !== argv[1] || result.health.product !== 'catbots'
      || result.health.bundleId !== 'com.catbots.desktop') throw new Error('health');
  if (exact(result.health, healthKeys) && result.health.releaseId === result.releaseId
      && result.health.readiness === 'ready' && result.health.resumePolicy === 'manual-only') return 'ready';
  if (exact(result.health, stoppedKeys) && result.health.state === 'stopped') return 'stopped';
  throw new Error('health');
}
JXA
  ) || fail 'signed installer did not report exact final state'
"$CHMOD" 600 "$installer_result_file"
installer_output=$(/bin/cat "$installer_result_file")
printf '%s\n' "$installer_output"
if [ "$installer_state" = stopped ]; then
  printf 'Catbots %s is installed and intentionally stopped.\n' "$release_version"
else
  printf 'Catbots %s is healthy.\n' "$release_version"
fi
