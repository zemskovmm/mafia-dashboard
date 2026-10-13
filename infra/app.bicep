targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = 'northeurope'

@minLength(3)
@maxLength(18)
param namePrefix string = 'mafiadashboard'

@description('Explicit account from the approved Storage foundation.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@minLength(3)
@maxLength(63)
param storageTableName string = 'MafiaEntities'

@minLength(3)
@maxLength(63)
param storageContainerName string = 'mafia-live'

@description('Stable partition identity. Changing this selects another dataset, not a migration.')
@minLength(1)
@maxLength(256)
param storagePartitionKey string

@description('Explicit first empty-store initialization only. Routine deployments must leave this false.')
param initializeStorage bool = false

@minLength(1)
param image string
param publicAppUrl string = ''
param ghcrUsername string = ''

@secure()
param ghcrToken string = ''

param googleClientId string = ''

@secure()
param googleClientSecret string = ''

@secure()
param musicTokenEncryptionKey string = ''

var environmentName = '${namePrefix}-env'
var appName = '${namePrefix}-app'
var googleConfigured = !empty(googleClientId) && !empty(googleClientSecret) && !empty(publicAppUrl)
var musicConfigured = googleConfigured && !empty(musicTokenEncryptionKey)
var ghcrConfigured = !empty(ghcrUsername) && !empty(ghcrToken)
var appSecrets = concat(
  googleConfigured
    ? [
        {
          name: 'google-client-secret'
          value: googleClientSecret
        }
      ]
    : [],
  musicConfigured
    ? [
        {
          name: 'music-token-encryption-key'
          value: musicTokenEncryptionKey
        }
      ]
    : [],
  ghcrConfigured
    ? [
        {
          name: 'ghcr-token'
          value: ghcrToken
        }
      ]
    : []
)
var storageEnv = [
  {
    name: 'STORAGE_PROVIDER'
    value: 'azure'
  }
  {
    name: 'AZURE_STORAGE_ACCOUNT_NAME'
    value: storageAccountName
  }
  {
    name: 'AZURE_STORAGE_TABLE_NAME'
    value: storageTableName
  }
  {
    name: 'AZURE_STORAGE_CONTAINER_NAME'
    value: storageContainerName
  }
  {
    name: 'AZURE_STORAGE_PARTITION_KEY'
    value: storagePartitionKey
  }
  {
    name: 'AZURE_CLIENT_ID'
    value: storageIdentity.properties.clientId
  }
]
var appEnv = concat(
  storageEnv,
  [
    {
      name: 'NODE_ENV'
      value: 'production'
    }
    {
      name: 'HOST'
      value: '0.0.0.0'
    }
    {
      name: 'PORT'
      value: '3000'
    }
    {
      name: 'TRUST_PROXY_HOPS'
      value: '1'
    }
    {
      name: 'STATIC_DIR'
      value: '/app/apps/web/dist'
    }
    {
      name: 'AZURE_STORAGE_INITIALIZE'
      value: 'false'
    }
    {
      name: 'PUBLIC_APP_URL'
      value: publicAppUrl
    }
  ],
  googleConfigured
    ? [
        {
          name: 'GOOGLE_CLIENT_ID'
          value: googleClientId
        }
        {
          name: 'GOOGLE_CLIENT_SECRET'
          secretRef: 'google-client-secret'
        }
      ]
    : [],
  musicConfigured
    ? [
        {
          name: 'GOOGLE_OAUTH_REDIRECT_URI'
          value: '${publicAppUrl}/api/music/oauth/callback'
        }
        {
          name: 'MUSIC_TOKEN_ENCRYPTION_KEY'
          secretRef: 'music-token-encryption-key'
        }
      ]
    : []
)
var initializationEnv = concat(storageEnv, [
  {
    name: 'AZURE_STORAGE_INITIALIZE'
    value: initializeStorage ? 'true' : 'false'
  }
])

resource storageIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${namePrefix}-storage'
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${storageIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 3000
        transport: 'auto'
      }
      registries: ghcrConfigured
        ? [
            {
              server: 'ghcr.io'
              username: ghcrUsername
              passwordSecretRef: 'ghcr-token'
            }
          ]
        : []
      secrets: appSecrets
    }
    template: {
      initContainers: [
        {
          name: 'initialize-storage'
          image: image
          command: [
            'node'
          ]
          args: [
            'apps/server/dist/initialize-storage.js'
          ]
          env: initializationEnv
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      containers: [
        {
          name: 'app'
          image: image
          env: appEnv
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health/live'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 20
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

output appFqdn string = app.properties.configuration.ingress.fqdn
output publicUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
