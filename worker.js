function getUserRole() {
    // Updated logic to return "none" instead of null
    return "none";
}

function checkAccess(role) {
    // Updated access control for role 'none'
    if (role === 'none') {
        return ['/promptlist'];
    }
    // Existing logic for other roles... (placeholder for other access)
}

function handleCommand(command, userRole) {
    if (userRole === 'none') {
        // Updated logic for suggestions and command handling
        return 'Suggestions for none role...'; // Add relevant suggestions
    }
    // Existing command handling logic...
}
