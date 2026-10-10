export interface User {
  _id: string
  userId: string
  name: string
  email: string
  isVerified: boolean
}

export interface OrgSummary { id: string; name: string; role: Role }

export type Role = 'owner' | 'admin' | 'sales_manager' | 'sales_rep' | 'developer' | 'viewer'

export type Stage = 'new' | 'qualified' | 'discovery' | 'proposal' | 'negotiation' | 'won' | 'lost'
export const STAGES: Stage[] = ['new', 'qualified', 'discovery', 'proposal', 'negotiation', 'won', 'lost']

export interface Evidence { claim: string; sourceUrl?: string; confidence?: number; verified: boolean }

export interface Lead {
  _id: string
  company: { name: string; website?: string; domain?: string; industry?: string; size?: string; country?: string }
  contact?: { name?: string; title?: string; email?: string; phone?: string }
  consent?: { basis: string; source?: string }
  research?: { status: string; summary?: string; needs?: string[]; evidence?: Evidence[]; researchedAt?: string }
  qualification?: { score?: number; rationale?: string; flags?: string[]; status: string }
  outreachStatus: string
  opportunityStage: Stage
  requirements?: { needs?: string[]; budget?: string; timeline?: string }
  createdAt: string
  updatedAt: string
}

export interface Message {
  _id: string
  direction: 'inbound' | 'outbound'
  kind: string
  to?: string
  from?: string
  subject?: string
  body: string
  status: string
  intent?: string
  error?: string
  approvalId?: string
  sentAt?: string
  createdAt: string
}

export interface Conversation {
  _id: string
  leadId: string
  subject?: string
  status: string
  summary?: string
  lastIntent?: string
  lastMessageAt?: string
  lead?: Pick<Lead, '_id' | 'company' | 'contact' | 'opportunityStage'> | null
}

export interface Workflow {
  _id: string
  type: string
  entityType: string
  entityId: string
  status: string
  currentStep: string
  attempts: number
  failureCode?: string
  lastError?: string
  result?: { outcome?: string } | null
  createdAt: string
  updatedAt: string
}

export interface AgentTask {
  _id: string
  agent: string
  status: string
  model?: string
  inputTokens: number
  outputTokens: number
  durationMs?: number
  error?: string
  output?: unknown
  createdAt: string
}

export interface Approval {
  _id: string
  actionType: string
  targetType: string
  targetId: string
  leadId?: string
  payload: { to?: string; subject?: string; body?: string; totalMinor?: number; discountPercent?: number }
  payloadHash: string
  reasons: string[]
  status: string
  createdAt: string
  expiresAt: string
  lead?: Pick<Lead, '_id' | 'company' | 'contact' | 'opportunityStage'> | null
}

export interface Proposal {
  _id: string
  leadId: string
  items: { name: string; priceMinor: number }[]
  currency: string
  subtotalMinor: number
  discountPercent: number
  totalMinor: number
  body: string
  status: string
  createdAt: string
}

export interface Service { name: string; description: string; basePriceMinor: number; deliveryDaysMin?: number; deliveryDaysMax?: number }

export interface BusinessProfile {
  businessName: string
  businessType: string
  description: string
  website: string
  services: Service[]
  idealCustomerProfile: { industries: string[]; companySizes: string[]; regions: string[]; requiredSignals: string[]; disqualifiers: string[] }
  brandVoice: string
  approvedClaims: string[]
  prohibitedClaims: string[]
  caseStudies: { title: string; summary: string }[]
}

export interface PolicyConfig {
  outreach: {
    enabled: boolean
    channels: 'email'[]
    autoSend: boolean
    requireConsentBasis: boolean
    maxNewContactsPerDay: number
    maxFollowUps: number
    minimumFollowUpIntervalHours: number
    quietHours: { enabled: boolean; start: string; end: string; timezone: string }
  }
  qualification: { minimumScore: number }
  pricing: { currency: string; minimumDealValueMinor: number; maximumDiscountPercent: number }
  proposals: { autoSend: boolean }
  budgets: { maxLlmCallsPerDay: number }
}

export interface AuditEvent {
  _id: string
  actorType: string
  actorId: string
  action: string
  targetType?: string
  targetId?: string
  decision?: string | null
  outcome: string
  policyVersion?: number
  metadata?: Record<string, unknown>
  createdAt: string
}
