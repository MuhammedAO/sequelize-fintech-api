const express = require("express")
const bodyParser = require("body-parser")
const { sequelize } = require("./model")
const { Op, fn, col } = require("sequelize")
const { getProfile } = require("./middleware/getProfile")
const app = express()
app.use(bodyParser.json())
app.set("sequelize", sequelize)
app.set("models", sequelize.models)

/**
 * FIX ME!
 * @returns contract by id
 */
app.get("/contracts/:id", getProfile, async (req, res) => {
  console.log("req", req.params)
  const { Contract } = req.app.get("models")
  const { id } = req.params
  const profileId = req.profile.id

  const contract = await Contract.findOne({
    where: {
      id,
      clientId: profileId,
    },
  })

  if (!contract) return res.status(404).end()
  res.json(contract)
})

/**
 * GET /contracts
 * Description: Fetches all the contracts for a logged-in user. Only returns active contracts.
 * Response: An array of contract objects that belong to the user.
 */


app.get("/contracts", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models")

  const profileId = req.profile.id

  try {
    // Fetch contracts where the user is either the client or the contractor and status is 'in_progress'
    const activeContracts = await Contract.findAll({
      where: {
        [Op.or]: [{ ClientId: profileId }, { ContractorId: profileId }],
        status: "in_progress",
      },
    })

    if (activeContracts.length === 0) {
      return res.status(404).json({ message: "No active contracts found" })
    }

    res.json(activeContracts)
  } catch (error) {
    console.log(error)
    res
      .status(500)
      .json({ error: "An error occurred while fetching the contracts" })
  }
})
/**
 * GET /jobs/unpaid
 * Description: Retrieves all unpaid jobs for a logged-in user (either a client or contractor) from active contracts.
 * Response: An array of job objects that are unpaid and belong to active contracts of the user.
 */

app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const { Job, Contract } = req.app.get("models")

  const profileId = req.profile.id

  try {
    // Fetch active contracts for the user
    const activeContracts = await Contract.findAll({
      where: {
        [Op.or]: [{ ClientId: profileId }, { ContractorId: profileId }],
        status: "in_progress",
      },
      attributes: ["id"], // We only need the contract IDs
    })

    // Extract the contract IDs
    const contractIds = activeContracts.map((contract) => contract.id)

    // Fetch unpaid jobs within these contracts
    const unpaidJobs = await Job.findAll({
      where: {
        ContractId: { [Op.in]: contractIds },
        paid: false, // Check if the job is not paid
      },
    })

    res.json(unpaidJobs)
  } catch (error) {
    res.status(500).json({ error: "An error occurred while fetching the jobs" })
  }
})
/**
 * POST /jobs/:job_id/pay
 * Description: Allows a client to pay for a job. The client can only pay if their balance >= the amount to pay.
 * Path Parameters:
 *   - job_id: The ID of the job to be paid.
 * Response: A success message if the payment is processed, or an error message if the payment cannot be processed.
 */

app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
  const { Job, Profile, Contract } = req.app.get("models")
  const jobId = parseInt(req.params.job_id, 10)

  if (isNaN(jobId)) {
    return res.status(400).json({ error: "Invalid job ID" })
  }

  const clientId = req.profile.id

  try {
    const job = await Job.findOne({ where: { id: jobId } })

    if (!job) {
      return res.status(404).json({ error: "Job not found" })
    }

    if (job.paid) {
      return res.status(400).json({ error: "Job is already paid" })
    }

    const contract = await Contract.findOne({ where: { id: job.ContractId } })
    if (!contract) {
      return res.status(404).json({ error: "Contract not found" })
    }

    const client = await Profile.findOne({
      where: { id: clientId, type: "client" },
    })
    const contractor = await Profile.findOne({
      where: { id: contract.ContractorId, type: "contractor" },
    })

    if (!client) {
      return res.status(404).json({ error: "Client not found" })
    }

    if (client.balance < job.price) {
      return res.status(400).json({ error: "Insufficient funds" })
    }

    if (!contractor) {
      return res.status(404).json({ error: "Contractor not found" })
    }

    // Transaction to ensure atomicity of the payment process
    await sequelize.transaction(async (t) => {
      // Deducting the amount from the client's balance
      await client.update(
        { balance: parseFloat(client.balance) - parseFloat(job.price) },
        { transaction: t }
      )

      // Adding the amount to the contractor's balance
      await contractor.update(
        { balance: parseFloat(contractor.balance) + parseFloat(job.price) },
        { transaction: t }
      )

      // Marking the job as paid
      await job.update(
        { paid: true, paymentDate: new Date() },
        { transaction: t }
      )
    })

    res.json({ message: "Payment successful" })
  } catch (error) {
    console.error(error)
    res
      .status(500)
      .json({ error: "An error occurred while processing the payment" })
  }
})
/**
 * POST /balances/deposit/:userId
 * Description: Deposits money into the balance of a client. A client cannot deposit more than 25% of the total cost of jobs to be paid.
 * Path Parameters:
 *   - userId: The ID of the client making the deposit.
 * Response: A success message with the new balance after the deposit, or an error message if the deposit is not allowed.
 */

app.post("/balances/deposit/:userId", async (req, res) => {
  const { Profile, Job, Contract } = req.app.get("models")
  const userId = parseInt(req.params.userId, 10)
  const { amount } = req.body 

  if (isNaN(userId) || amount <= 0) {
    return res.status(400).json({ error: "Invalid request" })
  }

  try {
    const client = await Profile.findOne({
      where: { id: userId, type: "client" },
    })
    if (!client) {
      return res.status(404).json({ error: "Client not found" })
    }

    // Calculate the total cost of unpaid jobs
    const unpaidJobsTotal = await Job.sum("price", {
      include: [
        {
          model: Contract,
          where: { ClientId: userId, status: "in_progress" },
        },
      ],
      where: { paid: false },
    })

    // Calculate maximum deposit amount (25% of unpaid jobs total)
    const maxDeposit = unpaidJobsTotal * 0.25

    if (amount > maxDeposit) {
      return res
        .status(400)
        .json({
          error: `Deposit exceeds the maximum allowed limit of ${maxDeposit}`,
        })
    }

    // Update the client's balance
    await client.update({
      balance: parseFloat(client.balance) + parseFloat(amount),
    })

    res.json({ message: "Deposit successful", newBalance: client.balance })
  } catch (error) {
    console.error(error)
    res
      .status(500)
      .json({ error: "An error occurred while processing the deposit" })
  }
})

/**
 * GET /admin/best-profession
 * Description: Returns the profession that earned the most money (sum of jobs paid) for any contractor who worked within the specified date range.
 * Query Parameters:
 *   - start: The start date of the query period (format: YYYY-MM-DD).
 *   - end: The end date of the query period (format: YYYY-MM-DD).
 * Response: An object containing the best-earning profession and the total amount earned within the date range.
 */

app.get('/admin/best-profession', async (req, res) => {
    const { Job, Contract, Profile } = req.app.get('models');
    const { start, end } = req.query;

    // Validate start and end dates
    if (!start || !end) {
        return res.status(400).json({ error: 'Start and end dates are required' });
    }

    try {
        // Aggregate job payments by profession
        const professionsEarnings = await Job.findAll({
            attributes: [
                [fn('sum', col('price')), 'totalEarnings'],
                [col('Contract.Contractor.profession'), 'profession']
            ],
            include: [{
                model: Contract,
                attributes: [],
                include: [{
                    model: Profile,
                    as: 'Contractor',
                    attributes: [],
                    where: { type: 'contractor' }
                }]
            }],
            where: {
                paid: true,
                paymentDate: {
                    [Op.between]: [new Date(start), new Date(end)]
                }
            },
            group: ['Contract.Contractor.profession'],
            order: [[fn('sum', col('price')), 'DESC']],
            limit: 1
        });

        if (professionsEarnings.length === 0) {
            return res.status(404).json({ error: 'No professions found in the specified date range' });
        }

        const bestProfession = professionsEarnings[0].dataValues;
        res.json({ profession: bestProfession.profession, totalEarnings: bestProfession.totalEarnings });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'An error occurred while fetching the best profession' });
    }
});


/**
 * GET /admin/best-clients
 * Description: Returns the clients who have paid the most for jobs within a specified time period.
 * Query Parameters:
 *   - start: The start date for the query period.
 *   - end: The end date for the query period.
 *   - limit (optional): The maximum number of clients to return. Default is 2.
 * Response: An array of client objects, including the total amount paid by each client, sorted in descending order of the amount paid.
 */
app.get('/admin/best-clients', async (req, res) => {
    const { Job, Contract, Profile } = req.app.get('models');
    const { start, end, limit = 2 } = req.query; // Default limit is 2

    // Validate start and end dates
    if (!start || !end) {
        return res.status(400).json({ error: 'Start and end dates are required' });
    }

    try {
        // Query to find clients who paid the most for jobs
        const bestClients = await Job.findAll({
            attributes: [
                [fn('sum', col('price')), 'totalPaid'],
                [col('Contract->Client.firstName'), 'firstName'],
                [col('Contract->Client.lastName'), 'lastName'],
                'Contract.ClientId'
            ],
            include: [{
                model: Contract,
                required: true,
                attributes: [],
                include: [{
                    model: Profile,
                    as: 'Client',
                    attributes: ['firstName', 'lastName']
                }]
            }],
            where: {
                paid: true,
                paymentDate: {
                    [Op.between]: [new Date(start), new Date(end)]
                }
            },
            group: ['Contract.ClientId', 'Contract->Client.id'],
            order: [[fn('sum', col('price')), 'DESC']],
            limit: parseInt(limit, 10) || 2
        });        
        res.json(bestClients);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'An error occurred while fetching the best clients' });
    }
    
});




module.exports = app
