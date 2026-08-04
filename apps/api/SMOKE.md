# Smoke API examples (replace TOKEN)

# Register
curl -s -X POST http://127.0.0.1:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"user1@test.com\",\"password\":\"secret12\",\"displayName\":\"U1\"}"

# Login admin
curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@example.com\",\"password\":\"ChangeMe123!\"}"

# Create plan (admin)
curl -s -X POST http://127.0.0.1:3000/api/admin/plans \
  -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"US Optimized 2C2G\",\"slug\":\"us-2c2g\",\"regionLabel\":\"US\",\"cpu\":2,\"memoryMb\":2048,\"diskGb\":40,\"matchRulesJson\":{\"regions\":[\"us-west\"],\"min_cpu\":2,\"min_memory_mb\":2048},\"prices\":[{\"currency\":\"CNY\",\"priceCents\":9900},{\"currency\":\"USD\",\"priceCents\":1500}]}"

# Add inventory
curl -s -X POST http://127.0.0.1:3000/api/admin/inventory \
  -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d "{\"code\":\"CC-001\",\"provider\":\"cloudcone\",\"ip\":\"1.2.3.4\",\"username\":\"root\",\"password\":\"x\",\"cpu\":2,\"memoryMb\":2048,\"diskGb\":40,\"region\":\"us-west\",\"optimizeTags\":[\"bbr\"]}"

# Mark ready
curl -s -X POST http://127.0.0.1:3000/api/admin/inventory/1/status \
  -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d "{\"status\":\"ready\"}"

# User order CNY
curl -s -X POST http://127.0.0.1:3000/api/orders \
  -H "Authorization: Bearer USER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"planId\":\"1\",\"currency\":\"CNY\"}"

# Pay
curl -s -X POST http://127.0.0.1:3000/api/orders/ORDERNO/pay \
  -H "Authorization: Bearer USER_TOKEN"
