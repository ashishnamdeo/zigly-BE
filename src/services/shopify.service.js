const { config } = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const POLL_ATTEMPTS = 5;
const POLL_DELAY_MS = 1000;

function adminApiUrl() {
  return `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;
}

async function graphql(query, variables) {
  const response = await fetch(adminApiUrl(), {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': config.shopify.adminToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();
  if (!response.ok || data.errors) {
    throw new Error(data.errors ? JSON.stringify(data.errors) : `Shopify API returned status ${response.status}`);
  }
  return data.data;
}

async function createStagedUpload(filename, mimeType) {
  const query = `
    mutation generateStagedUploads($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    input: [{ filename, mimeType, httpMethod: 'POST', resource: 'FILE' }],
  };

  const data = await graphql(query, variables);
  const { stagedTargets, userErrors } = data.stagedUploadsCreate;
  if (userErrors.length) {
    throw new Error(userErrors.map((e) => e.message).join('; '));
  }
  return stagedTargets[0];
}

async function uploadToStagedTarget(stagedTarget, fileBuffer, filename, mimeType) {
  const form = new FormData();
  for (const { name, value } of stagedTarget.parameters) {
    form.append(name, value);
  }
  form.append('file', new Blob([fileBuffer], { type: mimeType }), filename);

  const response = await fetch(stagedTarget.url, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`Staged upload to Shopify failed with status ${response.status}`);
  }
}

async function createFile(resourceUrl, isDocument) {
  const query = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
        }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    files: [{ originalSource: resourceUrl, contentType: isDocument ? 'FILE' : 'IMAGE' }],
  };

  const data = await graphql(query, variables);
  const { files, userErrors } = data.fileCreate;
  if (userErrors.length) {
    throw new Error(userErrors.map((e) => e.message).join('; '));
  }
  return files[0].id;
}

async function pollForPublicUrl(fileId) {
  const query = `
    query getFile($id: ID!) {
      node(id: $id) {
        ... on MediaImage { fileStatus image { url } }
        ... on GenericFile { fileStatus url }
      }
    }
  `;

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const data = await graphql(query, { id: fileId });
    const node = data.node;
    const url = node?.image?.url || node?.url;
    if (node?.fileStatus === 'READY' && url) {
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
  }
  throw new Error(`Shopify file ${fileId} did not become ready in time`);
}

/**
 * Uploads a file to Shopify's own CDN (staged upload + fileCreate) so it has a
 * stable public HTTPS URL Gupshup can fetch — avoids needing our own storage
 * (S3/local disk), which doesn't persist reliably on Lambda anyway.
 */
async function uploadPrescriptionFile({ buffer, filename, mimeType, isDocument }) {
  try {
    const stagedTarget = await createStagedUpload(filename, mimeType);
    await uploadToStagedTarget(stagedTarget, buffer, filename, mimeType);
    const fileId = await createFile(stagedTarget.resourceUrl, isDocument);
    return await pollForPublicUrl(fileId);
  } catch (err) {
    logger.error('Shopify file upload failed', { error: err.message });
    throw new ApiError(502, 'Failed to upload prescription file to Shopify', { message: err.message });
  }
}

module.exports = { uploadPrescriptionFile };
