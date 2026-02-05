"""
Order Processing Workflow with Data Flow Annotations for Visualization.

This version includes explicit data flow metadata that can be parsed
by DaprVis to show how data objects and properties travel between activities.
"""
from datetime import timedelta
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any, TypedDict
from dapr.ext.workflow import DaprWorkflowContext, workflow, activity, when_all, when_any


# =============================================================================
# DATA FLOW METADATA FOR VISUALIZATION
# =============================================================================
# This metadata describes how data flows through the workflow.
# DaprVis can parse this to render data lineage on the visualization.

WORKFLOW_DATA_FLOW = {
    "workflow": "order_processing_workflow",
    "input_schema": {
        "type": "OrderInput",
        "properties": ["order_id", "items", "payment", "shipping_address", "customer_email"]
    },
    "data_flows": [
        # Step 1: validate_order
        {
            "activity": "validate_order",
            "consumes": [
                {"source": "workflow_input", "path": "input"}  # Full OrderInput
            ],
            "produces": {"name": "is_valid", "type": "bool"}
        },
        # Step 2: Parallel - check_inventory & check_fraud
        {
            "activity": "check_inventory",
            "consumes": [
                {"source": "workflow_input", "path": "input.items"}
            ],
            "produces": {"name": "inventory_result", "type": "dict", "properties": ["available", "items_checked"]}
        },
        {
            "activity": "check_fraud",
            "consumes": [
                {"source": "workflow_input", "path": "input.payment"}
            ],
            "produces": {"name": "fraud_result", "type": "dict", "properties": ["is_fraud", "risk_score"]}
        },
        # Step 3: reserve_inventory
        {
            "activity": "reserve_inventory",
            "consumes": [
                {"source": "workflow_input", "path": "input.items"}
            ],
            "produces": {"name": "reservation", "type": "dict", "properties": ["reservation_id", "items"]}
        },
        # Step 4: process_payment - NOTE: consumes from WORKFLOW INPUT, not previous activity!
        {
            "activity": "process_payment",
            "consumes": [
                {"source": "workflow_input", "path": "input.payment"}  # From original input!
            ],
            "produces": {"name": "payment_result", "type": "dict", "properties": ["success", "transaction_id", "amount"]}
        },
        # Compensation: release_inventory (if payment fails)
        {
            "activity": "release_inventory",
            "condition": "not payment_result['success']",
            "consumes": [
                {"source": "reservation", "path": "reservation['reservation_id']"}  # From activity output
            ],
            "produces": {"name": "_", "type": "bool"}
        },
        # Step 5: refund_payment (on timeout)
        {
            "activity": "refund_payment",
            "condition": "approval_timeout",
            "consumes": [
                {"source": "payment_result", "path": "payment_result['transaction_id']"}
            ],
            "produces": {"name": "_", "type": "bool"}
        },
        # Step 6: shipping_workflow (child workflow)
        {
            "activity": "shipping_workflow",
            "type": "child_workflow",
            "consumes": [
                {"source": "workflow_input", "path": "input.order_id"},
                {"source": "workflow_input", "path": "input.shipping_address"}
            ],
            "produces": {"name": "shipping_result", "type": "dict", "properties": ["tracking_number", "pickup_date"]}
        },
        # Step 7: Parallel notifications
        {
            "activity": "send_email_notification",
            "consumes": [
                {"source": "workflow_input", "path": "input.customer_email"},
                {"source": "workflow_input", "path": "input.order_id"},
                {"source": "shipping_result", "path": "shipping_result['tracking_number']"}
            ],
            "produces": {"name": "email_result", "type": "dict"}
        },
        {
            "activity": "send_sms_notification",
            "consumes": [
                {"source": "workflow_input", "path": "input.order_id"}
            ],
            "produces": {"name": "sms_result", "type": "dict"}
        },
        {
            "activity": "send_push_notification",
            "consumes": [
                {"source": "workflow_input", "path": "input.order_id"}
            ],
            "produces": {"name": "push_result", "type": "dict"}
        },
    ]
}


# =============================================================================
# TYPE DEFINITIONS
# =============================================================================

@dataclass
class OrderInput:
    """Input data for order processing workflow."""
    order_id: str
    items: List[dict]
    payment: dict
    shipping_address: str
    customer_email: str


@dataclass
class OrderResult:
    """Result of order processing workflow."""
    status: str
    success: bool
    tracking_number: Optional[str] = None
    notifications_sent: Optional[List[str]] = None


# =============================================================================
# WORKFLOW DEFINITION
# =============================================================================

@workflow
async def order_processing_workflow(ctx: DaprWorkflowContext, input: OrderInput) -> OrderResult:
    """
    Order processing workflow with explicit data flow comments for visualization.
    
    DATA SOURCES:
    - `input`: The original OrderInput passed when workflow starts
    - Activity outputs: Variables storing results from each activity
    
    The workflow orchestrator has access to ALL data and decides what to pass
    to each activity. Activities don't automatically chain - data routing is explicit.
    """
    
    # =========================================================================
    # Step 1: Validate the order
    # DATA FLOW: input (full OrderInput) → validate_order → is_valid
    # =========================================================================
    is_valid: bool = await ctx.call_activity(validate_order, input=input)
    
    if not is_valid:
        return OrderResult(status="Invalid", success=False)
    
    # =========================================================================
    # Step 2: Run inventory check and fraud check in PARALLEL
    # DATA FLOW: input.items → check_inventory → inventory_result
    # DATA FLOW: input.payment → check_fraud → fraud_result
    # =========================================================================
    inventory_task = ctx.call_activity(check_inventory, input=input.items)
    fraud_task = ctx.call_activity(check_fraud, input=input.payment)
    
    inventory_result, fraud_result = await when_all([inventory_task, fraud_task])
    
    if not inventory_result["available"]:
        return OrderResult(status="OutOfStock", success=False)
    
    if fraud_result["is_fraud"]:
        return OrderResult(status="FraudDetected", success=False)
    
    # =========================================================================
    # Step 3: Reserve inventory
    # DATA FLOW: input.items → reserve_inventory → reservation
    # =========================================================================
    reservation: dict = await ctx.call_activity(reserve_inventory, input=input.items)
    
    # =========================================================================
    # Step 4: Process payment
    # DATA FLOW: input.payment → process_payment → payment_result
    # NOTE: Uses WORKFLOW INPUT (input.payment), NOT output from reserve_inventory!
    # =========================================================================
    payment_result: dict = await ctx.call_activity(process_payment, input=input.payment)
    
    if not payment_result["success"]:
        # =====================================================================
        # COMPENSATION: Release inventory
        # DATA FLOW: reservation["reservation_id"] → release_inventory
        # NOTE: Now we USE the output from reserve_inventory for compensation!
        # =====================================================================
        await ctx.call_activity(release_inventory, input=reservation["reservation_id"])
        return OrderResult(status="PaymentFailed", success=False)
    
    # =========================================================================
    # Step 5: Wait for manager approval if amount is high
    # DATA FLOW: input.payment["amount"] used for condition check
    # =========================================================================
    if input.payment["amount"] > 1000:
        approval_event = ctx.wait_for_external_event("manager_approval")
        timeout = ctx.create_timer(timedelta(hours=24))
        
        winner = await when_any([approval_event, timeout])
        
        if winner == timeout:
            # =================================================================
            # COMPENSATION: Refund and release
            # DATA FLOW: payment_result["transaction_id"] → refund_payment
            # DATA FLOW: reservation["reservation_id"] → release_inventory
            # =================================================================
            await ctx.call_activity(refund_payment, input=payment_result["transaction_id"])
            await ctx.call_activity(release_inventory, input=reservation["reservation_id"])
            return OrderResult(status="ApprovalTimeout", success=False)
    
    # =========================================================================
    # Step 6: Ship the order using child workflow
    # DATA FLOW: input.order_id + input.shipping_address → shipping_workflow → shipping_result
    # NOTE: Combines data from WORKFLOW INPUT to construct child workflow input
    # =========================================================================
    shipping_result: dict = await ctx.call_child_workflow(
        shipping_workflow,
        input={"order_id": input.order_id, "address": input.shipping_address}
    )
    
    # =========================================================================
    # Step 7: Send notifications in PARALLEL
    # DATA FLOW: input.customer_email + input.order_id + shipping_result["tracking_number"]
    #            → send_email_notification
    # DATA FLOW: input.order_id → send_sms_notification
    # DATA FLOW: input.order_id → send_push_notification
    # NOTE: Mixes WORKFLOW INPUT with ACTIVITY OUTPUT (shipping_result)!
    # =========================================================================
    email_task = ctx.call_activity(send_email_notification, input={
        "to": input.customer_email,           # From workflow input
        "order_id": input.order_id,           # From workflow input
        "tracking": shipping_result["tracking_number"]  # From activity output!
    })
    sms_task = ctx.call_activity(send_sms_notification, input={
        "order_id": input.order_id            # From workflow input
    })
    push_task = ctx.call_activity(send_push_notification, input={
        "order_id": input.order_id            # From workflow input
    })
    
    notification_results = await when_all([email_task, sms_task, push_task])
    
    # =========================================================================
    # Final Result
    # DATA FLOW: shipping_result + notification_results → OrderResult
    # =========================================================================
    return OrderResult(
        status="Completed",
        success=True,
        tracking_number=shipping_result["tracking_number"],
        notifications_sent=[r["channel"] for r in notification_results if r["sent"]]
    )


@workflow
async def shipping_workflow(ctx: DaprWorkflowContext, input: dict) -> dict:
    """Child workflow for handling shipping logistics."""
    
    label: dict = await ctx.call_activity(create_shipping_label, input=input)
    pickup: dict = await ctx.call_activity(schedule_pickup, input=label)
    await ctx.wait_for_external_event("package_picked_up")
    
    return {"tracking_number": label["tracking_number"], "pickup_date": pickup["date"]}


# =============================================================================
# ACTIVITY DEFINITIONS
# =============================================================================

@activity
async def validate_order(ctx, input: OrderInput) -> bool:
    return len(input.items) > 0

@activity
async def check_inventory(ctx, input: List[dict]) -> dict:
    return {"available": True, "items_checked": len(input)}

@activity
async def check_fraud(ctx, input: dict) -> dict:
    return {"is_fraud": False, "risk_score": 0.1}

@activity
async def reserve_inventory(ctx, input: List[dict]) -> dict:
    return {"reservation_id": "res_12345", "items": input}

@activity
async def release_inventory(ctx, input: str) -> bool:
    return True

@activity
async def process_payment(ctx, input: dict) -> dict:
    return {"success": True, "transaction_id": "txn_12345", "amount": input.get("amount", 0)}

@activity
async def refund_payment(ctx, input: str) -> bool:
    return True

@activity
async def create_shipping_label(ctx, input: dict) -> dict:
    return {"tracking_number": "TRK123456789", "carrier": "FedEx"}

@activity
async def schedule_pickup(ctx, input: dict) -> dict:
    return {"scheduled": True, "date": "2026-01-27"}

@activity
async def send_email_notification(ctx, input: dict) -> dict:
    return {"sent": True, "channel": "email"}

@activity
async def send_sms_notification(ctx, input: dict) -> dict:
    return {"sent": True, "channel": "sms"}

@activity
async def send_push_notification(ctx, input: dict) -> dict:
    return {"sent": True, "channel": "push"}
