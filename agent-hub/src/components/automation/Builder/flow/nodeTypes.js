import AggregateNode from './nodes/AggregateNode';
import DatatableNode from './nodes/DatatableNode';
import KnowledgeWriteNode from './nodes/KnowledgeWriteNode';
import AiStepNode from './nodes/AiStepNode';
import AiToolNode from './nodes/AiToolNode';
import CallFlowletNode from './nodes/CallFlowletNode';
import CallStepNode from './nodes/CallStepNode';
import CodeNode from './nodes/CodeNode';
import DataExtractionNode from './nodes/DataExtractionNode';
import ConditionNode from './nodes/ConditionNode';
import DateTimeNode from './nodes/DateTimeNode';
import DedupeNode from './nodes/DedupeNode';
import FilterNode from './nodes/FilterNode';
import FlowletOutputNode from './nodes/FlowletOutputNode';
import ApprovalNode from './nodes/ApprovalNode';
import FormPageNode from './nodes/FormPageNode';
import GhostStepNode from './nodes/GhostStepNode';
import GuardNode from './nodes/GuardNode';
import HttpRequestNode from './nodes/HttpRequestNode';
import GenerateDocumentNode from './nodes/GenerateDocumentNode';
import FillDocumentNode from './nodes/FillDocumentNode';
import SlideNode from './nodes/SlideNode';
import PresentationNode from './nodes/PresentationNode';
import IntegrationActionNode from './nodes/IntegrationActionNode';
import LimitNode from './nodes/LimitNode';
import LoopItemNode from './nodes/LoopItemNode';
import LoopNode from './nodes/LoopNode';
import NoteNode from './nodes/NoteNode';
import ParallelNode from './nodes/ParallelNode';
import RowLabelNode from './nodes/RowLabelNode';
import NotificationNode from './nodes/NotificationNode';
import ParseJsonNode from './nodes/ParseJsonNode';
import SetNode from './nodes/SetNode';
import StopErrorNode from './nodes/StopErrorNode';
import ReturnToAppNode from './nodes/ReturnToAppNode';
import SummarizeNode from './nodes/SummarizeNode';
import SwitchNode from './nodes/SwitchNode';
import TokenizeNode from './nodes/TokenizeNode';
import TriggerNode from './nodes/TriggerNode';
import UntokenizeNode from './nodes/UntokenizeNode';
import WaitNode from './nodes/WaitNode';

// Exported so flow/nodeDefs.test.js can assert this and flow/nodeDefs.js name
// the same set of step types: every renderable type needs a presentation
// record, and every record needs either a component here or a documented
// reason in nodeDefs' PALETTE_ABSENT. A type missing from one side used to
// surface as a raw type name in the UI (or, for approval/parallel, a bare
// unstyled React Flow default node with no handles).
export const NODE_TYPES = {
    trigger:            TriggerNode,
    integration_action: IntegrationActionNode,
    ai_step:            AiStepNode,
    data_extraction:    DataExtractionNode,
    condition:          ConditionNode,
    loop:               LoopNode,
    code:               CodeNode,
    notification:       NotificationNode,
    http_request:       HttpRequestNode,
    generate_document:  GenerateDocumentNode,
    fill_document:      FillDocumentNode,
    slide:              SlideNode,
    presentation:       PresentationNode,
    form_page:          FormPageNode,
    // n8n-style utility nodes
    set:                SetNode,
    parse_json:         ParseJsonNode,
    datetime:           DateTimeNode,
    wait:               WaitNode,
    approval:           ApprovalNode,
    stop_error:         StopErrorNode,
    // The other terminal step — ends the run and answers the Studio App.
    return_to_app:      ReturnToAppNode,
    switch:             SwitchNode,
    filter:             FilterNode,
    // Held branches that run at the same time. Registered late (the engine and
    // the validator have always known this type), which is why the comment
    // above still names it as the example of the bare-default-node failure.
    parallel:           ParallelNode,
    guard:              GuardNode,
    tokenize:           TokenizeNode,
    untokenize:         UntokenizeNode,
    limit:              LimitNode,
    dedupe:             DedupeNode,
    aggregate:          AggregateNode,
    datatable:          DatatableNode,
    knowledge_write:    KnowledgeWriteNode,
    summarize:          SummarizeNode,
    // Canvas annotation — never wired, never executed (BFSF-411).
    note:               NoteNode,
    // Flowlets (reusable sub-automations)
    call_layer:         CallFlowletNode,
    layer_output:       FlowletOutputNode,
    // Steps (reusable standalone building blocks, kind='block')
    call_block:         CallStepNode,
    // Canvas-only: the "Each item" pill at the head of an expanded loop. Not a
    // step — see nodeDefs' SYNTHETIC_TYPES.
    loop_item:          LoopItemNode,
    // Canvas-only: one chip per entry in an AI step's `tools` array, hanging
    // off its bottom port. Also not a step — see flow/aiToolNodes.js.
    ai_tool:            AiToolNode,
    // Canvas-only: the gutter label above a wrapped row — see flow/rowBands.js.
    row_label:          RowLabelNode,
    // Canvas-only: the dashed "next step" slot ahead of the AI's frontier while
    // it builds — see flow/useBuildChoreography.js.
    ghost_step:         GhostStepNode,
};
