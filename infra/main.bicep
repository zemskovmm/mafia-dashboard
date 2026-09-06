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

@description('Non-secret fingerprint recorded only by a successful foundation deployment.')
param foundationFingerprint string

var uniqueSuffix = uniqueString(subscription().id, resourceGroup().id)
var postgresServerName = take('${namePrefix}-pg-${uniqueSuffix}', 63)
var environmentName = '${namePrefix}-env'
var privateDnsZoneName = '${uniqueSuffix}.postgres.database.azure.com'

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

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
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

output postgresServerName string = postgres.name
output deployedDatabaseName string = database.name
output containerAppName string = '${namePrefix}-app'
output environmentName string = environment.name
output foundationFingerprint string = foundationFingerprint
output resourceIds array = [
  vnet.id
  containerSubnet.id
  postgresSubnet.id
  privateDns.id
  privateDnsLink.id
  postgres.id
  database.id
  environment.id
]