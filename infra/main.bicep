targetScope = 'resourceGroup'

@description('Region of the existing Container Apps environment and the new Storage account.')
param location string = 'northeurope'

@minLength(3)
@maxLength(18)
param namePrefix string = 'mafiadashboard'

@description('Explicit never-used account name for the approved empty-store cutover. Do not adopt an unknown existing account.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@minLength(3)
@maxLength(63)
param storageTableName string = 'MafiaEntities'

@minLength(3)
@maxLength(63)
param storageContainerName string = 'mafia-live'

@description('Non-secret fingerprint recorded only by a successful foundation deployment.')
param foundationFingerprint string

// Existing PostgreSQL, VNet/subnets, DNS and Container Apps environment are
// deliberately not managed here. Apply ONLY in Incremental mode to retain them.
resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: storageAccountName
  location: location
  tags: {
    application: '${namePrefix}-app'
    purpose: 'azure-authoritative-storage'
  }
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    // Private data via OAuth, not a private endpoint. No existing network changes.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Allow'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: storage
  name: 'default'
  properties: {}
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobService
  name: storageContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2025-01-01' = {
  parent: storage
  name: 'default'
  properties: {}
}

resource table 'Microsoft.Storage/storageAccounts/tableServices/tables@2025-01-01' = {
  parent: tableService
  name: storageTableName
  properties: {}
}

resource storageIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-storage'
  location: location
}

// This account is dedicated to this app. Only its Table/Blob data roles are
// granted: no account keys, subscription-wide access or SQL permissions.
resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, storageIdentity.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: storage
  properties: {
    principalId: storageIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
    )
  }
}

resource tableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, storageIdentity.id, '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
  scope: storage
  properties: {
    principalId: storageIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
    )
  }
}

output containerAppName string = '${namePrefix}-app'
output environmentName string = '${namePrefix}-env'
output storageAccountName string = storage.name
output storageTableName string = table.name
output storageContainerName string = container.name
output storageIdentityClientId string = storageIdentity.properties.clientId
output foundationFingerprint string = foundationFingerprint
output resourceIds array = [
  storage.id
  blobService.id
  container.id
  tableService.id
  table.id
  storageIdentity.id
  blobRole.id
  tableRole.id
]
