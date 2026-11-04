var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { ok = true }));
app.MapGet("/", () => Results.Ok(new { name = "{{NAME}}" }));

app.Run();
