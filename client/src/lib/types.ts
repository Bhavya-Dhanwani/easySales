export interface User {
  _id: string
  userId: string
  name: string
  email: string
  isVerified: boolean
}

export interface OrgSummary { id: string; name: string; role: Role }

export type Role = 'owner' | 'admin' | 'sales_manager' | 'sales_rep' | 'developer' | 'viewer'

export type Stage = 'new' | 'qualified' | 'discovery' | 'proposal' | 'negotiation' | 'nurture' | 'won' | 'lost'
export const STAGES: Stage[] = ['new', 'qualified', 'discovery', 'proposal', 'negotiation', 'nurture', 'won', 'lost']

export interface Evidence { claim: string; sourceUrl?: string; confidence?: number; verified: boolean }

export type LeadStatus = 'new' | 'research_queued' | 'researching' | 'qualified' | 'needs_review' | 'disqualified' | 'research_failed'
export const LEAD_STATUSES: LeadStatus[] = ['new', 'research_queued', 'researching', 'qualified', 'needs_review', 'disqualified', 'research_failed']

export interface Criterion { criterionId: string; label: string; weight: number; result: 'match' | 'partial' | 'mismatch' | 'unknown'; explanation: string; evidenceUrls: string[] }

export interface ImportJob {
  _id: string
  status: string
  fileName?: string
  totalRows: number
  createdRows: number
  duplicateRows: number
  invalidRows: number
  createdAt: string
  completedAt?: string
}

export interface ResearchJob {
  _id: string
  type: string
  entityId: string
  status: string
  currentStep: string
  attempts: number
  maxAttempts: number
  failureCode?: string
  lastError?: string
  result?: { outcome?: string } | null
  createdAt: string
  updatedAt: string
  usage: { calls: number; inputTokens: number; outputTokens: number } | null
  lead?: { _id: string; company: { name: string }; status: LeadStatus } | null
}

export interface Lead {
  _id: string
  company: { name: string; website?: string; domain?: string; industry?: string; size?: string; employeeCount?: number; country?: string; description?: string }
  contact?: { name?: string; title?: string; email?: string; phone?: string }
  consent?: { basis: string; source?: string }
  status: LeadStatus
  research?: { status: string; summary?: string; needs?: string[]; evidence?: Evidence[]; sources?: string[]; conflicts?: string[]; researchedAt?: string; profileVersion?: number }
  qualification?: { priority?: "high" | "medium" | "low"; score?: number; evidenceCoverage?: number; rationale?: string; flags?: string[]; criteria?: Criterion[]; evaluatedAt?: string; profileVersion?: number; overriddenBy?: string }
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
  deliveredAt?: string
  createdAt: string
  campaignId?: string
  classification?: { confidence?: number; requiresHuman?: boolean; recommendedAction?: string }
  claims?: { claim: string; evidenceUrl?: string; verified: boolean }[]
  lead?: { _id: string; company: { name: string }; contact?: { name?: string; email?: string } } | null
}

export interface Campaign {
  _id: string
  name: string
  objective: string
  status: 'draft' | 'active' | 'paused' | 'completed'
  audience: { statuses: string[]; minScore: number; industries: string[]; countries: string[] }
  followUpDelaysDays: number[]
  dailyLimit: number
  autoSend: boolean
  startedAt?: string
  createdAt: string
  enrolled?: number
}

export interface CampaignAnalytics {
  range: string | { from: string; to: string }
  enrolled: number; threads: number; drafted: number; pendingApproval: number; queued: number
  accepted: number; delivered: number; bounced: number; failed: number; blockedByPolicy: number
  repliedThreads: number; optedOut: number; complaints: number; meetings: number
  rates: Record<string, { value: number | null; of: string }>
}

export interface EmailIntegration {
  _id: string
  status: 'connected' | 'error' | 'disconnected'
  fromName: string
  fromEmail: string
  replyTo?: string
  smtp: { host: string; port: number; secure: boolean; user: string }
  lastVerifiedAt?: string
  lastError?: string
  webhookUrl: string
}

export interface Conversation {
  _id: string
  leadId: string
  subject?: string
  status: string
  conversationState?: string
  campaignId?: string
  assignedTo?: string
  nextActionAt?: string
  lastInboundAt?: string
  followUpsSent?: number
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
  payload: { to?: string; subject?: string; body?: string; totalMinor?: number; discountPercent?: number; templateId?: string; requirementsVersion?: number; budgetMinorUnits?: number; currency?: string; action?: string; params?: Record<string, unknown> }
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
  version: number
  revisionNote?: string
  requirementsVersion: number
  priceBookVersion: number
  prototypeId?: string
  items: { name: string; quantity?: number; unitPriceMinor?: number; priceMinor: number }[]
  currency: string
  subtotalMinor: number
  discountPercent: number
  discountMinor: number
  taxBasisPoints: number
  taxMinor: number
  totalMinor: number
  paymentSchedule: { label: string; percent: number; amountMinor: number }[]
  body: string
  status: string
  approvedBy?: string
  sentAt?: string
  expiresAt?: string
  acceptance?: { acceptedBy?: string; acceptedAt?: string; evidence?: string }
  createdAt: string
}

export type FeatureStatus = 'confirmed' | 'assumed' | 'needs_clarification'

export interface RequirementsDoc {
  _id: string
  version: number
  createdBy: string
  changeSummary: string
  createdAt: string
  sourceMessageIds: string[]
  requirements: {
    title: string
    projectType: string
    problemStatement: string
    targetUsers: string[]
    features: { name: string; description: string; priority: 'must' | 'should' | 'could'; status: FeatureStatus }[]
    design: { brandColors: string[]; visualDirection: string; referenceUrls: string[] }
    constraints: { budgetMinorUnits: number | null; currency: string; targetDate: string | null; technologies: string[] }
    acceptanceCriteria: string[]
    openQuestions: string[]
    sourceMessageIds: string[]
  }
}

export interface Prototype {
  _id: string
  requirementsVersion: number
  templateId: string
  status: string
  budgetMinorUnits: number
  costMinorUnits: number
  currency: string
  previewUrl?: string
  previewExpiresAt?: string
  qaReport?: { buildPassed?: boolean; testsPassed?: boolean; securityPassed?: boolean; findings: string[] }
  attempts: number
  maxAttempts: number
  failureCode?: string
  approvalId?: string
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
  meetingLink?: string
  terms?: string
  revisionRounds?: number
  paymentSchedule?: { label: string; percent: number }[]
  scoringWeights?: Record<string, number>
  version?: number
}

export interface PolicyConfig {
  outreach: {
    enabled: boolean
    channels: 'email'[]
    autoSend: boolean
    requireConsentBasis: boolean
    maxNewContactsPerDay: number
    maxPerHour: number
    maxFollowUps: number
    minimumFollowUpIntervalHours: number
    quietHours: { enabled: boolean; start: string; end: string; timezone: string }
  }
  qualification: { minimumScore: number; minimumEvidenceCoverage: number; reviewScore: number }
  pricing: { currency: string; minimumDealValueMinor: number; maximumDiscountPercent: number; maximumDealValueMinor: number; taxBasisPoints: number; proposalValidityDays: number }
  proposals: { autoSend: boolean }
  budgets: { maxLlmCallsPerDay: number; monthlySpendMinor: number; maxResearchPerDay: number; maxConcurrentResearch: number; maxConcurrentBuilds: number; artifactStorageBytes: number }
  prototypes: { enabled: boolean; autoBuild: boolean; costPerAttemptMinor: number; maxAttempts: number; maxPerPrototypeMinor: number; monthlyBudgetMinor: number; previewDays: number }
  retention: { messageDays: number; auditDays: number }
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
