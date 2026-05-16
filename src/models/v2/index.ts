/**
 * v2 data model — Company / Person / CompanyPerson / SourceRecord / Signal.
 *
 * Designed to replace the legacy flat `Lead` model. Key differences from legacy:
 *  - Split entities (Company vs Person) with an edge table (CompanyPerson)
 *  - Field-level provenance via SourceRecord
 *  - Signal collection for trigger-based queries
 *  - Tech + industry are canonical fields on Company (not scattered on Lead)
 *
 * NOT YET wired into the pipeline — scaffolded alongside the old model so we
 * can migrate incrementally. Once the new ingest path is built, a one-time
 * migration script will convert existing Lead records into Company+Person+edges.
 */
export { default as CompanyV2 } from './Company.js';
export type { ICompany } from './Company.js';
export { default as PersonV2 } from './Person.js';
export type { IPerson } from './Person.js';
export { default as CompanyPersonV2 } from './CompanyPerson.js';
export type { ICompanyPerson, Seniority, Department } from './CompanyPerson.js';
export { default as SourceRecord, recordSource } from './SourceRecord.js';
export type { ISourceRecord, EntityType, ExtractionMethod, RecordSourceInput } from './SourceRecord.js';
export { default as Signal } from './Signal.js';
export type { ISignal, SignalType } from './Signal.js';
