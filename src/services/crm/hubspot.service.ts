// Reserved for future pull-sync implementation. Push-sync logic is inlined in workers/src/hubspot.worker.ts.
export interface HubSpotCompanyInput {
  name: string;
  domain?: string;
  industry?: string;
  city?: string;
  country?: string;
}

export interface HubSpotContactInput {
  firstName?: string;
  lastName?: string;
  fullName: string;
  email?: string;
  jobTitle?: string;
}

export interface HubSpotUpsertResult {
  id: string;   // HubSpot object ID (hs_object_id)
  status: 'created' | 'existing';
}

async function hubspotRequest(
  accessToken: string,
  method: string,
  url: string,
  body?: unknown
): Promise<unknown> {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    throw new Error(`HubSpot API error: ${resp.status} ${method} ${url}`);
  }

  return resp.json();
}

export async function upsertCompany(
  accessToken: string,
  company: HubSpotCompanyInput
): Promise<HubSpotUpsertResult> {
  let input: Record<string, unknown>;

  if (company.domain) {
    input = {
      idProperty: 'domain',
      id: company.domain,
      properties: {
        name: company.name,
        domain: company.domain,
        industry: company.industry,
        city: company.city,
        country: company.country,
      },
    };
  } else {
    input = {
      properties: {
        name: company.name,
        industry: company.industry,
        city: company.city,
        country: company.country,
      },
    };
  }

  const result = await hubspotRequest(
    accessToken,
    'POST',
    'https://api.hubapi.com/crm/v3/objects/companies/batch/upsert',
    { inputs: [input] }
  ) as { results: Array<{ id: string; status: string }> };

  const first = result.results[0];
  if (!first) throw new Error('HubSpot returned empty results for company upsert');
  return {
    id: first.id,
    status: first.status === 'CREATED' ? 'created' : 'existing',
  };
}

export async function upsertContact(
  accessToken: string,
  contact: HubSpotContactInput
): Promise<HubSpotUpsertResult> {
  let input: Record<string, unknown>;

  if (contact.email) {
    input = {
      idProperty: 'email',
      id: contact.email,
      properties: {
        firstname: contact.firstName,
        lastname: contact.lastName,
        email: contact.email,
        jobtitle: contact.jobTitle,
      },
    };
  } else {
    input = {
      properties: {
        firstname: contact.firstName,
        lastname: contact.lastName,
        jobtitle: contact.jobTitle,
      },
    };
  }

  const result = await hubspotRequest(
    accessToken,
    'POST',
    'https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert',
    { inputs: [input] }
  ) as { results: Array<{ id: string; status: string }> };

  const first = result.results[0];
  if (!first) throw new Error('HubSpot returned empty results for contact upsert');
  return {
    id: first.id,
    status: first.status === 'CREATED' ? 'created' : 'existing',
  };
}

export async function associateContactToCompany(
  accessToken: string,
  contactId: string,
  companyId: string
): Promise<void> {
  await hubspotRequest(
    accessToken,
    'PUT',
    'https://api.hubapi.com/crm/v4/associations/contacts/companies/batch/create',
    {
      inputs: [
        {
          from: { id: contactId },
          to: { id: companyId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }],
        },
      ],
    }
  );
}

export async function getRecentCompanies(
  accessToken: string,
  modifiedAfter: Date
): Promise<Array<{ id: string; domain: string; modifiedAt: string }>> {
  const filterGroups = JSON.stringify([
    {
      filters: [
        {
          propertyName: 'hs_lastmodifieddate',
          operator: 'GTE',
          value: modifiedAfter.toISOString(),
        },
      ],
    },
  ]);

  const url = `https://api.hubapi.com/crm/v3/objects/companies?limit=100&properties=domain,name&filterGroups=${encodeURIComponent(filterGroups)}`;
  const data = await hubspotRequest(accessToken, 'GET', url) as {
    results: Array<{ id: string; properties: { domain: string }; updatedAt: string }>;
  };

  return data.results.map((r) => ({
    id: r.id,
    domain: r.properties.domain,
    modifiedAt: r.updatedAt,
  }));
}
