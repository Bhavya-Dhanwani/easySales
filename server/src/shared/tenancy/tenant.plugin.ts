// Importing modules
import { Schema, Query } from "mongoose";

// query operations that must always be scoped to an organization
const SCOPED_OPERATIONS = [
    "find", "findOne", "countDocuments", "updateOne", "updateMany",
    "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "replaceOne",
] as const;

// spread into every tenant-owned schema definition (kept here so the TypeScript types see it)
export const tenantFields = {
    organizationId: {
        type: Schema.Types.ObjectId,
        ref: "Organization",
        required: true,
        index: true,
        immutable: true,
    },
} as const;

/*
    Requires an organizationId on the schema and refuses to run any query
    that does not filter by it. This makes "forgot the tenant filter" a crash in tests
    instead of a cross-tenant data leak in production.

    Cross-tenant system code (the job worker leasing work) opts out explicitly with
    `.setOptions({ crossTenant: true })`.
*/
function tenantPlugin(schema: Schema) {

    if (!schema.path("organizationId")) throw new Error("tenantPlugin requires ...tenantFields in the schema definition");

    // guarding every query operation
    for (const op of SCOPED_OPERATIONS) {
        schema.pre(op, function (this: Query<unknown, unknown>) {
            if (this.getOptions().crossTenant) return;
            const filter = this.getFilter();
            if (!filter || filter.organizationId === undefined || filter.organizationId === null) {
                throw new Error(`Unscoped ${op} on ${this.model.modelName}: organizationId filter is required`);
            }
        });
    }

    // guarding aggregations the same way: the first stage must match on organizationId
    schema.pre("aggregate", function () {
        if (this.options.crossTenant) return;
        const first = this.pipeline()[0] as { $match?: { organizationId?: unknown } } | undefined;
        if (!first?.$match?.organizationId) {
            throw new Error("Unscoped aggregate: first stage must $match organizationId");
        }
    });

}

export default tenantPlugin;
