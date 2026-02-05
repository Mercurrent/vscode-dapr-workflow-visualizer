using Dapr.Workflow;
using System;
using System.Threading.Tasks;

namespace DaprWorkflowSamples;

/// <summary>
/// Sample order processing workflow demonstrating various Dapr workflow features
/// </summary>
public class OrderProcessingWorkflow : Workflow<OrderInput, OrderResult>
{
    public override async Task<OrderResult> RunAsync(WorkflowContext ctx, OrderInput input)
    {
        // Step 1: Validate the order
        var isValid = await ctx.CallActivityAsync<bool>("ValidateOrder", input);
        
        if (!isValid)
        {
            return new OrderResult { Status = "Invalid", Success = false };
        }

        // Step 2: Reserve inventory
        await ctx.CallActivityAsync<bool>("ReserveInventory", input.Items);

        // Step 3: Process payment
        var paymentResult = await ctx.CallActivityAsync<PaymentResult>("ProcessPayment", input.Payment);

        if (!paymentResult.Success)
        {
            // Compensate: Release inventory
            await ctx.CallActivityAsync<bool>("ReleaseInventory", input.Items);
            return new OrderResult { Status = "PaymentFailed", Success = false };
        }

        // Step 4: Wait for manager approval if amount is high
        if (input.Payment.Amount > 1000)
        {
            // Set a timeout for approval
            using var cts = new CancellationTokenSource();
            var approvalTask = ctx.WaitForExternalEvent<ApprovalResult>("ManagerApproval");
            var timeoutTask = ctx.CreateTimer(TimeSpan.FromHours(24));

            var winner = await Task.WhenAny(approvalTask, timeoutTask);
            
            if (winner == timeoutTask)
            {
                // Timeout - refund and cancel
                await ctx.CallActivityAsync<bool>("RefundPayment", paymentResult.TransactionId);
                await ctx.CallActivityAsync<bool>("ReleaseInventory", input.Items);
                return new OrderResult { Status = "ApprovalTimeout", Success = false };
            }
        }

        // Step 5: Ship the order using sub-orchestration
        var shippingResult = await ctx.CallSubOrchestratorAsync<ShippingResult>(
            "ShippingWorkflow", 
            new ShippingInput { OrderId = input.OrderId, Address = input.ShippingAddress }
        );

        // Step 6: Send confirmation
        await ctx.CallActivityAsync<bool>("SendConfirmationEmail", input.CustomerEmail);

        return new OrderResult 
        { 
            Status = "Completed", 
            Success = true,
            TrackingNumber = shippingResult.TrackingNumber
        };
    }
}

// Supporting types
public record OrderInput(string OrderId, List<OrderItem> Items, PaymentInfo Payment, string ShippingAddress, string CustomerEmail);
public record OrderResult { public string Status { get; init; } public bool Success { get; init; } public string? TrackingNumber { get; init; } }
public record PaymentResult(bool Success, string TransactionId);
public record ApprovalResult(bool Approved, string ApproverName);
public record ShippingInput(string OrderId, string Address);
public record ShippingResult(string TrackingNumber);
public record OrderItem(string ProductId, int Quantity);
public record PaymentInfo(decimal Amount, string Method);
