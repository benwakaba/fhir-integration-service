// HTTP errors. The shared error handler turns `status` into the response code.
// Routes under /fhir answer with an OperationOutcome whose issue code is `code`;
// the developer API answers { error: message }.

export class HttpError extends Error {
  constructor(status, message, { code = 'processing', issues, headers } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code; // OperationOutcome.issue.code (http://hl7.org/fhir/issue-type)
    this.issues = issues; // optional validation issues to include in the OperationOutcome
    this.headers = headers;
  }
}

export const badRequest = (message) => new HttpError(400, message, { code: 'invalid' });
export const notFound = (message) => new HttpError(404, message, { code: 'not-found' });
export const gone = (message) => new HttpError(410, message, { code: 'deleted' });
export const conflict = (message) => new HttpError(409, message, { code: 'conflict' });

/** If-Match named a version that is no longer current. */
export const preconditionFailed = (message) => new HttpError(412, message, { code: 'conflict' });

/** Version-aware update attempted without If-Match. */
export const preconditionRequired = (message) => new HttpError(428, message, { code: 'business-rule' });

/** The body parsed, but violates FHIR R4 structure or our write rules. */
export const unprocessable = (message, issues) => new HttpError(422, message, { code: 'processing', issues });
