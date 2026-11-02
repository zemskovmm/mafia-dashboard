targetScope = 'resourceGroup'

// Explicit first-time staging bootstrap only. Invoke separately in Incremental
// mode; ordinary foundation/app releases must not own or recreate this environment.
@description('Approved region for the isolated staging environment.')
@allowed([
  'northeurope'
])
param location string = 'northeurope'

@description('Staging-only resource names; never adopt the production environment.')
@allowed([
  'mafiadashboard-stg'
])
param namePrefix string = 'mafiadashboard-stg'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    // Workload-profile Consumption supports managed identity in init containers;
    // omitting this list would create the legacy consumption-only environment.
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        // The service consumes this key internally; it is never a parameter/output.
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

output environmentName string = environment.name
output environmentId string = environment.id
output logAnalyticsWorkspaceId string = logs.id
output resourceIds array = [
  logs.id
  environment.id
]
