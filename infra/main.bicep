targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@minLength(3)
@maxLength(18)
param namePrefix string = 'mafiadashboard'

param deployApp bool = false
param image string = ''
param publicAppUrl string = ''
param googleClientId string = ''

@secure()
param googleClientSecret string = ''

@secure()
param musicTokenEncryptionKey string = ''

@secure()
param postgresPassword string

param postgresAdminUser string = 'mafiaadmin'

var uniqueSuffix = uniqueString(subscription().id, resourceGroup().id)
var compactPrefix = replace(toLower(namePrefix), '-', '')
var registryName = take('${compactPrefix}${uniqueSuffix}', 50)
var postgresServerName = take('${compactPrefix}-pg-${uniqueSuffix}', 63)
var environmentName = '${namePrefix}-env'
var appName = '${namePrefix}-app'
var identityName = '${namePrefix}-pull'
var databaseName = 'mafia'
var privateDnsZoneName = '${uniqueSuffix}.postgres.database.azure.com'
var registryServer = '${registry.name}.azurecr.io'
var databaseUrl = 'postgresql://${postgresAdminUser}:${postgresPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=verify-full'
var googleConfigured = !empty(googleClientId) && !empty(googleClientSecret) && !empty(publicAppUrl)
var musicConfigured = googleConfigured && !empty(musicTokenEncryptionKey)
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

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${namePrefix}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.20.0.0/24'
      ]
    }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: '10.20.0.0/27'
          delegations: [
            {
              name: 'Microsoft.App.environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.20.0.32/28'
          delegations: [
            {
              name: 'Microsoft.DBforPostgreSQL.flexibleServers'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }
}

resource containerSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'container-apps'
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'postgres'
}

resource privateDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneName
  location: 'global'
}

resource privateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDns
  name: '${namePrefix}-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: postgresAdminUser
    administratorLoginPassword: postgresPassword
    version: '17'
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: privateDns.id
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [
    privateDnsLink
  ]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: {}
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    policies: {
      quarantinePolicy: {
        status: 'disabled'
      }
      retentionPolicy: {
        days: 7
        status: 'enabled'
      }
      trustPolicy: {
        type: 'Notary'
        status: 'disabled'
      }
    }
  }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'none'
    }
    vnetConfiguration: {
      infrastructureSubnetId: containerSubnet.id
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
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
      registries: [
        {
          server: registryServer
          identity: pullIdentity.id
        }
      ]
      secrets: appSecrets
    }
    template: {
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
        minReplicas: 0
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
  dependsOn: [
    acrPullRole
    database
  ]
}

output registryName string = registry.name
output registryServer string = registryServer
output postgresServerName string = postgres.name
output containerAppName string = appName
output appFqdn string = deployApp ? app!.properties.configuration.ingress.fqdn : ''
output publicUrl string = deployApp ? 'https://${app!.properties.configuration.ingress.fqdn}' : ''
