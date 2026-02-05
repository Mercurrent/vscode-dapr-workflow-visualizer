from datetime import timedelta
from dataclasses import dataclass
from typing import List, Optional, Dict, Any
from dapr.ext.workflow import DaprWorkflowContext, workflow, activity, when_all, when_any


@dataclass
class OrderInput:
    order_id: str
    items: List[dict]
    payment: dict
    shipping_address: str
    customer_email: str


@dataclass
class OrderResult:
    status: str
    success: bool
    tracking_number: Optional[str] = None
    notifications_sent: Optional[List[str]] = None


@workflow
async def order_processing_workflow(ctx: DaprWorkflowContext, input: OrderInput) -> OrderResult:
    """
    Sample order processing workflow demonstrating various Dapr workflow features.
    This workflow handles the complete order lifecycle from validation to shipping.
    """
    
    # Step 1: Validate the order
    is_valid: bool = await ctx.call_activity(validate_order, input=input)
    
    if not is_valid:
        return OrderResult(status="Invalid", success=False)
    
    # Step 2: Run inventory check and fraud check in PARALLEL
    inventory_task = ctx.call_activity(check_inventory, input=input.items)
    fraud_task = ctx.call_activity(check_fraud, input=input.payment)
    
    # Wait for both parallel tasks to complete
    inventory_result, fraud_result = await when_all([inventory_task, fraud_task])
    
    if not inventory_result["available"]:
        return OrderResult(status="OutOfStock", success=False)
    
    if fraud_result["is_fraud"]:
        return OrderResult(status="FraudDetected", success=False)
    
    # Step 3: Reserve inventory
    reservation: dict = await ctx.call_activity(reserve_inventory, input=input.items)
    
    # Step 4: Process payment
    payment_result: dict = await ctx.call_activity(process_payment, input=input.payment)
    
    if not payment_result["success"]:
        # Compensate: Release inventory
        await ctx.call_activity(release_inventory, input=reservation["reservation_id"])
        return OrderResult(status="PaymentFailed", success=False)
    
    # Step 5: Wait for manager approval if amount is high
    if input.payment["amount"] > 1000:
        # Race between approval event and timeout
        approval_event = ctx.wait_for_external_event("manager_approval")
        timeout = ctx.create_timer(timedelta(hours=24))
        
        winner = await when_any([approval_event, timeout])
        
        if winner == timeout:
            # Timeout - refund and cancel
            await ctx.call_activity(refund_payment, input=payment_result["transaction_id"])
            await ctx.call_activity(release_inventory, input=reservation["reservation_id"])
            return OrderResult(status="ApprovalTimeout", success=False)
    
    # Step 6: Ship the order using child workflow
    shipping_result: dict = await ctx.call_child_workflow(
        shipping_workflow,
        input={"order_id": input.order_id, "address": input.shipping_address}
    )
    
    # Step 7: Send notifications in PARALLEL
    email_task = ctx.call_activity(send_email_notification, input={
        "to": input.customer_email,
        "order_id": input.order_id,
        "tracking": shipping_result["tracking_number"]
    })
    sms_task = ctx.call_activity(send_sms_notification, input={
        "order_id": input.order_id
    })
    push_task = ctx.call_activity(send_push_notification, input={
        "order_id": input.order_id
    })
    
    # Wait for all notifications (but don't fail if some don't work)
    notification_results = await when_all([email_task, sms_task, push_task])
    
    return OrderResult(
        status="Completed",
        success=True,
        tracking_number=shipping_result["tracking_number"],
        notifications_sent=[r["channel"] for r in notification_results if r["sent"]]
    )


@workflow
async def shipping_workflow(ctx: DaprWorkflowContext, input: dict) -> dict:
    """Child workflow for handling shipping logistics."""
    
    # Create shipping label
    label: dict = await ctx.call_activity(create_shipping_label, input=input)
    
    # Schedule pickup
    pickup: dict = await ctx.call_activity(schedule_pickup, input=label)
    
    # Wait for package to be picked up
    await ctx.wait_for_external_event("package_picked_up")
    
    return {"tracking_number": label["tracking_number"], "pickup_date": pickup["date"]}


# Activity definitions
@activity
async def validate_order(ctx, input: OrderInput) -> bool:
    """Validate order details."""
    return len(input.items) > 0


@activity
async def check_inventory(ctx, input: List[dict]) -> dict:
    """Check if items are in stock."""
    return {"available": True, "items_checked": len(input)}


@activity
async def check_fraud(ctx, input: dict) -> dict:
    """Check payment for fraud indicators."""
    return {"is_fraud": False, "risk_score": 0.1}


@activity
async def reserve_inventory(ctx, input: List[dict]) -> dict:
    """Reserve items in inventory."""
    return {"reservation_id": "res_12345", "items": input}


@activity
async def release_inventory(ctx, input: str) -> bool:
    """Release reserved inventory."""
    return True


@activity
async def process_payment(ctx, input: dict) -> dict:
    """Process payment transaction."""
    return {"success": True, "transaction_id": "txn_12345", "amount": input.get("amount", 0)}


@activity
async def refund_payment(ctx, input: str) -> bool:
    """Refund a payment transaction."""
    return True


@activity
async def create_shipping_label(ctx, input: dict) -> dict:
    """Create shipping label."""
    return {"tracking_number": "TRK123456789", "carrier": "FedEx"}


@activity
async def schedule_pickup(ctx, input: dict) -> dict:
    """Schedule package pickup."""
    return {"scheduled": True, "date": "2026-01-27"}


@activity
async def send_email_notification(ctx, input: dict) -> dict:
    """Send order confirmation email."""
    return {"sent": True, "channel": "email"}


@activity
async def send_sms_notification(ctx, input: dict) -> dict:
    """Send SMS notification."""
    return {"sent": True, "channel": "sms"}


@activity
async def send_push_notification(ctx, input: dict) -> dict:
    """Send push notification."""
    return {"sent": True, "channel": "push"}
