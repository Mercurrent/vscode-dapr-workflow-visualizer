import { WorkflowContext, WorkflowClient } from '@dapr/dapr';

interface OrderInput {
    orderId: string;
    items: Array<{ productId: string; quantity: number }>;
    payment: { amount: number; method: string };
    shippingAddress: string;
    customerEmail: string;
}

interface OrderResult {
    status: string;
    success: boolean;
    trackingNumber?: string;
}

interface PaymentResult {
    success: boolean;
    transactionId: string;
}

interface ShippingResult {
    trackingNumber: string;
}

/**
 * Sample order processing workflow demonstrating various Dapr workflow features.
 * This workflow handles the complete order lifecycle from validation to shipping.
 */
export async function* orderProcessingWorkflow(
    ctx: WorkflowContext,
    input: OrderInput
): AsyncGenerator<unknown, OrderResult> {
    
    // Step 1: Validate the order
    const isValid = yield ctx.callActivity<boolean>("validateOrder", input);
    
    if (!isValid) {
        return { status: "Invalid", success: false };
    }
    
    // Step 2: Reserve inventory
    yield ctx.callActivity<boolean>("reserveInventory", input.items);
    
    // Step 3: Process payment
    const paymentResult = yield ctx.callActivity<PaymentResult>("processPayment", input.payment);
    
    if (!paymentResult.success) {
        // Compensate: Release inventory
        yield ctx.callActivity<boolean>("releaseInventory", input.items);
        return { status: "PaymentFailed", success: false };
    }
    
    // Step 4: Wait for manager approval if amount is high
    if (input.payment.amount > 1000) {
        // Race between approval event and timeout
        const approvalPromise = ctx.waitForExternalEvent<{ approved: boolean }>("managerApproval");
        const timeoutPromise = ctx.createTimer(24 * 60 * 60 * 1000); // 24 hours
        
        const result = yield Promise.race([approvalPromise, timeoutPromise]);
        
        if (!result || result === "timeout") {
            // Timeout - refund and cancel
            yield ctx.callActivity<boolean>("refundPayment", paymentResult.transactionId);
            yield ctx.callActivity<boolean>("releaseInventory", input.items);
            return { status: "ApprovalTimeout", success: false };
        }
    }
    
    // Step 5: Ship the order using sub-orchestration
    const shippingResult = yield ctx.callSubOrchestration<ShippingResult>(
        "shippingWorkflow",
        { orderId: input.orderId, address: input.shippingAddress }
    );
    
    // Step 6: Send confirmation
    yield ctx.callActivity<boolean>("sendConfirmationEmail", input.customerEmail);
    
    return {
        status: "Completed",
        success: true,
        trackingNumber: shippingResult.trackingNumber
    };
}

/**
 * Child workflow for handling shipping logistics
 */
export async function* shippingWorkflow(
    ctx: WorkflowContext,
    input: { orderId: string; address: string }
): AsyncGenerator<unknown, ShippingResult> {
    
    // Create shipping label
    const label = yield ctx.callActivity<{ trackingNumber: string }>("createShippingLabel", input);
    
    // Schedule pickup
    yield ctx.callActivity<boolean>("schedulePickup", label);
    
    // Wait for package to be picked up
    yield ctx.waitForExternalEvent("packagePickedUp");
    
    return { trackingNumber: label.trackingNumber };
}

// Register workflows
export function registerWorkflows(client: WorkflowClient) {
    client.registerWorkflow(orderProcessingWorkflow);
    client.registerWorkflow(shippingWorkflow);
}
