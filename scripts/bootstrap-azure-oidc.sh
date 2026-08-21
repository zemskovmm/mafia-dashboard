#!/usr/bin/env bash
set -Eeuo pipefail

: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID}"
: "${AZURE_TENANT_ID:?Set AZURE_TENANT_ID}"
: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP}"
: "${AZURE_LOCATION:=northeurope}"
: "${AZURE_IDENTITY_NAME:=mafiadashboard-github}"
: "${GITHUB_ENVIRONMENT:=production}"
: "${GITHUB_FEDERATED_SUBJECT:=repo:zemskovmm@8973322/mafia-dashboard@1320321469:environment:production}"

for command in az gh; do
  command -v "$command" >/dev/null || {
    printf 'Required command not found: %s\n' "$command" >&2
    exit 1
  }
done

az account show --query id --output tsv >/dev/null
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az group create \
  --name "$AZURE_RESOURCE_GROUP" \
  --location "$AZURE_LOCATION" \
  --output none

az identity create \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_IDENTITY_NAME" \
  --location "$AZURE_LOCATION" \
  --output none
client_id=$(az identity show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_IDENTITY_NAME" \
  --query clientId \
  --output tsv)
principal_id=$(az identity show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_IDENTITY_NAME" \
  --query principalId \
  --output tsv)

if az identity federated-credential show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --identity-name "$AZURE_IDENTITY_NAME" \
  --name github-production >/dev/null 2>&1; then
  az identity federated-credential update \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --identity-name "$AZURE_IDENTITY_NAME" \
    --name github-production \
    --issuer https://token.actions.githubusercontent.com \
    --subject "$GITHUB_FEDERATED_SUBJECT" \
    --audiences api://AzureADTokenExchange \
    --output none
else
  az identity federated-credential create \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --identity-name "$AZURE_IDENTITY_NAME" \
    --name github-production \
    --issuer https://token.actions.githubusercontent.com \
    --subject "$GITHUB_FEDERATED_SUBJECT" \
    --audiences api://AzureADTokenExchange \
    --output none
fi

scope="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$AZURE_RESOURCE_GROUP"
assignment_count=$(az role assignment list \
  --assignee-object-id "$principal_id" \
  --scope "$scope" \
  --role Contributor \
  --query 'length(@)' \
  --output tsv)
if [[ "$assignment_count" == 0 ]]; then
  az role assignment create \
    --assignee-object-id "$principal_id" \
    --assignee-principal-type ServicePrincipal \
    --role Contributor \
    --scope "$scope" \
    --output none
fi

gh variable set AZURE_CLIENT_ID --env "$GITHUB_ENVIRONMENT" --body "$client_id"
gh variable set AZURE_TENANT_ID --env "$GITHUB_ENVIRONMENT" --body "$AZURE_TENANT_ID"
gh variable set AZURE_SUBSCRIPTION_ID --env "$GITHUB_ENVIRONMENT" --body "$AZURE_SUBSCRIPTION_ID"
gh variable set AZURE_RESOURCE_GROUP --env "$GITHUB_ENVIRONMENT" --body "$AZURE_RESOURCE_GROUP"
gh variable set AZURE_LOCATION --env "$GITHUB_ENVIRONMENT" --body "$AZURE_LOCATION"

printf 'Configured GitHub OIDC identity %s (%s) for %s.\n' \
  "$AZURE_IDENTITY_NAME" "$client_id" "$scope"
