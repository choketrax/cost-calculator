import asyncio
import os
import sys

from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client, StdioServerParameters

async def run_client():
    # Define how to start our MCP server via stdio
    # We will invoke our python module directly
    server_params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "core.mcp_server"],
        env=os.environ.copy()
    )

    print("Starting MCP Client and connecting to server...")
    
    # Connect to the server
    async with stdio_client(server_params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            
            # Initialize connection
            await session.initialize()
            print("Connected and initialized successfully!")
            
            # List available tools
            tools_response = await session.list_tools()
            print("\nAvailable Tools:")
            for tool in tools_response.tools:
                print(f" - {tool.name}: {tool.description}")
            
            # Test calling a tool
            print("\nTesting 'get_model_pricing' tool for 'openai' / 'gpt-4o'...")
            result = await session.call_tool(
                "get_model_pricing", 
                arguments={"provider": "openai", "model": "gpt-4o"}
            )
            
            print("Tool Response:")
            for content in result.content:
                print(content.text)

if __name__ == "__main__":
    asyncio.run(run_client())
