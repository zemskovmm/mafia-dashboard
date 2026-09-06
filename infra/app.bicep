targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = 'northeurope'

@minLength(3)
@maxLength(18)
param namePrefix string = 'mafiadashboard'

@secure()
param postgresPassword string

param postgresAdminUser string = 'mafiaadmin'

@description('Explicit target database; use a new name for an approved current-only cutover.')
@minLength(1)
@maxLength(63)
param databaseName string

param image string = ''
param publicAppUrl string = ''
param ghcrUsername string = ''

@secure()
param ghcrToken string = ''

param googleClientId string = ''

@secure()
param googleClientSecret string = ''

@secure()
param musicTokenEncryptionKey string = ''

var uniqueSuffix = uniqueString(subscription().id, resourceGroup().id)
var postgresServerName = take('${namePrefix}-pg-${uniqueSuffix}', 63)
var environmentName = '${namePrefix}-env'
var appName = '${namePrefix}-app'
var encodedPostgresPassword = uriComponent(postgresPassword)
var databaseUrl = 'postgresql://${postgresAdminUser}:${encodedPostgresPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/${database.name}?sslmode=verify-full'
var googleConfigured = !empty(googleClientId) && !empty(googleClientSecret) && !empty(publicAppUrl)
var musicConfigured = googleConfigured && !empty(musicTokenEncryptionKey)
var ghcrConfigured = !empty(ghcrUsername) && !empty(ghcrToken)
var appSecrets = concat(
  [
    {
      name: 'database-url'
      value: databaseUrl
    }
  ],
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
var appEnv = concat(
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
      name: 'DATABASE_URL'
      secretRef: 'database-url'
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
var migrationEnv = [
  {
    name: 'DATABASE_URL'
    secretRef: 'database-url'
  }
]

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: postgresServerName
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' existing = {
  parent: postgres
  name: databaseName
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
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
          name: 'migrate'
          image: image
          command: [
            'node'
          ]
          args: [
            'apps/server/dist/migrate.js'
          ]
          env: migrationEnv
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
