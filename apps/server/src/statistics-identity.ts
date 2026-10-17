/** Comparison keys only: preserve canonical spelling and non-UUID opaque IDs. */
export const statisticsIdentityKey = (id: string): string =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase()
    : id;
