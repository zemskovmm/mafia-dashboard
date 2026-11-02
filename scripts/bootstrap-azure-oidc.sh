#!/usr/bin/env bash
set -Eeuo pipefail

: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID}"
: "${AZURE_TENANT_ID:?Set AZURE_TENANT_ID}"
: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP}"
: "${AZURE_LOCATION:=northeurope}"
: "${AZURE_IDENTITY_NAME:?Set AZURE_IDENTITY_NAME}"
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY to owner/repo}"
: "${GITHUB_ENVIRONMENT:?Set GITHUB_ENVIRONMENT explicitly}"
: "${GITHUB_FEDERATED_SUBJECT:?Set GITHUB_FEDERATED_SUBJECT to the observed GitHub OIDC subject}"

fail() { printf '%s\n' "$1" >&2; exit 1; }

# Explicit project targets: a staging invocation must never repair production trust.
case "$GITHUB_ENVIRONMENT" in
  staging)
    expected_group=rg-mafia-dashboard-staging-neu
    expected_identity=mafiadashboard-stg-github
    ;;
  production)
    expected_group=rg-mafia-dashboard-prod-weu
    expected_identity=mafiadashboard-github
    ;;
  *) fail 'Unsupported GITHUB_ENVIRONMENT; choose staging or production explicitly.' ;;
esac
[[ "$AZURE_RESOURCE_GROUP" == "$expected_group" && "$AZURE_IDENTITY_NAME" == "$expected_identity" ]] ||
  fail 'Azure resource group/identity does not match the selected GitHub environment.'
[[ "$AZURE_LOCATION" == northeurope ]] || fail 'The approved targets are in northeurope.'
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'Invalid GITHUB_REPOSITORY.'

subject_repository=${GITHUB_FEDERATED_SUBJECT%:environment:*}
[[ "$GITHUB_FEDERATED_SUBJECT" == "$subject_repository:environment:$GITHUB_ENVIRONMENT" ]] ||
  fail 'OIDC subject must match the selected GitHub environment exactly.'
[[ "$subject_repository" =~ ^repo:([A-Za-z0-9_.-]+)(@[0-9]+)?/([A-Za-z0-9_.-]+)(@[0-9]+)?$ ]] ||
  fail 'OIDC subject must be an explicit repository/environment subject.'
[[ "${BASH_REMATCH[1]}/${BASH_REMATCH[3]}" == "$GITHUB_REPOSITORY" ]] ||
  fail 'OIDC subject repository does not match GITHUB_REPOSITORY.'
[[ ( -z "${BASH_REMATCH[2]}" && -z "${BASH_REMATCH[4]}" ) ||
   ( -n "${BASH_REMATCH[2]}" && -n "${BASH_REMATCH[4]}" ) ]] ||
  fail 'Immutable OIDC subjects must include both owner and repository IDs.'
credential_name="github-$GITHUB_ENVIRONMENT"

for command in az gh jq; do
  command -v "$command" >/dev/null || {
    printf 'Required command not found: %s\n' "$command" >&2
    exit 1
  }
done

uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
[[ "$AZURE_SUBSCRIPTION_ID" =~ $uuid_pattern && "$AZURE_TENANT_ID" =~ $uuid_pattern ]] ||
  fail 'Azure subscription and tenant IDs must be explicit UUIDs.'

az account set --subscription "$AZURE_SUBSCRIPTION_ID"
account=$(az account show --query '{id:id,tenantId:tenantId}' --output json --only-show-errors)
jq -e --arg subscription "$AZURE_SUBSCRIPTION_ID" --arg tenant "$AZURE_TENANT_ID" \
  '.id == $subscription and .tenantId == $tenant' <<<"$account" >/dev/null ||
  fail 'Selected Azure account does not match the requested subscription/tenant.'

scope="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$AZURE_RESOURCE_GROUP"
identity_id="$scope/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$AZURE_IDENTITY_NAME"
az group create --name "$AZURE_RESOURCE_GROUP" --location "$AZURE_LOCATION" --output none --only-show-errors
group=$(az group show --name "$AZURE_RESOURCE_GROUP" --query '{id:id,location:location}' --output json --only-show-errors)
jq -e --arg scope "$scope" --arg location "$AZURE_LOCATION" \
  '(.id | ascii_downcase) == ($scope | ascii_downcase) and .location == $location' <<<"$group" >/dev/null ||
  fail 'Resource group readback does not match the approved target.'

az identity create \
  --resource-group "$AZURE_RESOURCE_GROUP" --name "$AZURE_IDENTITY_NAME" \
  --location "$AZURE_LOCATION" --output none --only-show-errors
identity=$(az identity show \
  --resource-group "$AZURE_RESOURCE_GROUP" --name "$AZURE_IDENTITY_NAME" \
  --query '{id:id,location:location,tenantId:tenantId,clientId:clientId,principalId:principalId}' \
  --output json --only-show-errors)
jq -e --arg id "$identity_id" --arg tenant "$AZURE_TENANT_ID" --arg location "$AZURE_LOCATION" \
  '(.id | ascii_downcase) == ($id | ascii_downcase) and .tenantId == $tenant and .location == $location' \
  <<<"$identity" >/dev/null || fail 'Deployment identity readback does not match the approved target.'
client_id=$(jq -er '.clientId' <<<"$identity")
principal_id=$(jq -er '.principalId' <<<"$identity")
[[ "$client_id" =~ $uuid_pattern && "$principal_id" =~ $uuid_pattern ]] ||
  fail 'Deployment identity is missing valid client/principal IDs.'

valid_credential() {
  jq -e --arg name "$credential_name" --arg subject "$GITHUB_FEDERATED_SUBJECT" '
    .name == $name and .subject == $subject and
    .issuer == "https://token.actions.githubusercontent.com" and
    .audiences == ["api://AzureADTokenExchange"]' >/dev/null
}
# Listing distinguishes a genuinely absent credential from an authorization or network failure.
credentials=$(az identity federated-credential list \
  --resource-group "$AZURE_RESOURCE_GROUP" --identity-name "$AZURE_IDENTITY_NAME" \
  --output json --only-show-errors)
jq -e 'type == "array" and length <= 1' <<<"$credentials" >/dev/null ||
  fail 'Unexpected existing federation; refusing to expand or replace trust.'
if [[ $(jq 'length' <<<"$credentials") == 0 ]]; then
  az identity federated-credential create \
    --resource-group "$AZURE_RESOURCE_GROUP" --identity-name "$AZURE_IDENTITY_NAME" \
    --name "$credential_name" --issuer https://token.actions.githubusercontent.com \
    --subject "$GITHUB_FEDERATED_SUBJECT" --audiences api://AzureADTokenExchange \
    --output none --only-show-errors
else
  jq '.[0]' <<<"$credentials" | valid_credential ||
    fail 'Existing federation does not match; refusing to replace trust implicitly.'
fi
credential=$(az identity federated-credential show \
  --resource-group "$AZURE_RESOURCE_GROUP" --identity-name "$AZURE_IDENTITY_NAME" \
  --name "$credential_name" --output json --only-show-errors)
valid_credential <<<"$credential" || fail 'Federated credential readback mismatch.'

contributor_count() {
  az role assignment list --assignee-object-id "$principal_id" --scope "$scope" \
    --role Contributor --fill-principal-name false --fill-role-definition-name false \
    --output json --only-show-errors |
    jq -er --arg scope "$scope" --arg principal "$principal_id" '
      if type != "array" then error("Invalid role assignment response") else
      [.[] | select((.scope | ascii_downcase) == ($scope | ascii_downcase) and
        .principalId == $principal and
        (.roleDefinitionId | endswith("/b24988ac-6180-42a0-ab88-20f7382dd24c")))] | length end'
}
assignment_count=$(contributor_count)
if [[ "$assignment_count" == 0 ]]; then
  az role assignment create \
    --assignee-object-id "$principal_id" --assignee-principal-type ServicePrincipal \
    --role Contributor --scope "$scope" --output none --only-show-errors
fi
[[ $(contributor_count) -gt 0 ]] || fail 'Resource-group Contributor assignment readback mismatch.'

set_variable() {
  gh variable set "$1" --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT" --body "$2"
  [[ $(gh variable get "$1" --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT" --json value --jq .value) == "$2" ]] ||
    fail 'GitHub environment variable readback mismatch.'
}
set_variable AZURE_CLIENT_ID "$client_id"
set_variable AZURE_TENANT_ID "$AZURE_TENANT_ID"
set_variable AZURE_SUBSCRIPTION_ID "$AZURE_SUBSCRIPTION_ID"
set_variable AZURE_RESOURCE_GROUP "$AZURE_RESOURCE_GROUP"
set_variable AZURE_LOCATION "$AZURE_LOCATION"

printf 'Configured GitHub OIDC identity %s (%s) for %s in %s.\n' \
  "$AZURE_IDENTITY_NAME" "$client_id" "$GITHUB_ENVIRONMENT" "$scope"
